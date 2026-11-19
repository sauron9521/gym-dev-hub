import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import type {
  GitHubCIState,
  GitHubDashboard,
  GitHubIssue,
  GitHubMilestone,
  GitHubPullRequest,
  GitHubSection,
  GitHubWorkflowRun,
} from '@gym-dev-hub/contracts';

interface RepositoryRaw {
  html_url: string;
  description: string | null;
  default_branch: string;
}
interface AccountRaw {
  login: string;
}
interface PullRequestRaw {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  user: AccountRaw | null;
  updated_at: string;
  head: { ref: string; sha: string };
}
interface IssueRaw {
  number: number;
  title: string;
  html_url: string;
  user: AccountRaw | null;
  updated_at: string;
  pull_request?: object;
  labels: Array<{ name: string }>;
}
interface MilestoneRaw {
  number: number;
  title: string;
  html_url: string;
  open_issues: number;
  closed_issues: number;
  due_on: string | null;
}
interface WorkflowRunRaw {
  id: number;
  name: string;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
}

function ciState(sha: string, runs: WorkflowRunRaw[]): GitHubCIState {
  const matching = runs.filter((run) => run.head_sha === sha);
  if (!matching.length) return 'unknown';
  if (matching.some((run) => run.status !== 'completed')) return 'pending';
  if (
    matching.some((run) =>
      ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(run.conclusion ?? ''),
    )
  ) {
    return 'failure';
  }
  if (matching.every((run) => run.conclusion === 'success')) return 'success';
  return 'unknown';
}

@Injectable()
export class GitHubService {
  private repositories(): string[] {
    const configured =
      process.env.GITHUB_REPOSITORIES ?? 'sauron9521/gym-dev-hub,sauron9521/gym-platform';

    const values = configured
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const valid = values.filter((value) => /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value));
    return [...new Set(valid)];
  }

  listAllowedRepositories(): string[] {
    return this.repositories();
  }

  assertAllowedRepository(repositoryInput?: string): string {
    const repositories = this.repositories();
    const repository = repositoryInput || repositories[0];
    if (!repository || !repositories.includes(repository)) {
      throw new BadRequestException('Репозиторій не дозволений конфігурацією Dev Hub');
    }
    return repository;
  }

  async request<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gym-dev-hub',
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

    const response = await fetch(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async getDashboard(repositoryInput?: string): Promise<GitHubDashboard> {
    const repositories = this.repositories();
    const repository = this.assertAllowedRepository(repositoryInput);
    const [owner, name] = repository.split('/');
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

    let info: RepositoryRaw;
    try {
      info = await this.request<RepositoryRaw>(root);
    } catch {
      throw new BadGatewayException(
        'Не вдалося завантажити репозиторій із GitHub. Перевірте доступ і ліміти API.',
      );
    }

    const settled = await Promise.allSettled([
      this.request<PullRequestRaw[]>(
        `${root}/pulls?state=open&sort=updated&direction=desc&per_page=15`,
      ),
      this.request<IssueRaw[]>(`${root}/issues?state=open&sort=updated&direction=desc&per_page=25`),
      this.request<MilestoneRaw[]>(`${root}/milestones?state=open&per_page=30`),
      this.request<{ workflow_runs: WorkflowRunRaw[] }>(`${root}/actions/runs?per_page=50`),
    ] as const);

    const unavailable: GitHubSection[] = [];
    const labels: GitHubSection[] = ['pulls', 'issues', 'milestones', 'runs'];
    settled.forEach((result, index) => {
      if (result.status === 'rejected') unavailable.push(labels[index]);
    });

    const rawPulls = settled[0].status === 'fulfilled' ? settled[0].value : [];
    const rawIssues = settled[1].status === 'fulfilled' ? settled[1].value : [];
    const rawMilestones = settled[2].status === 'fulfilled' ? settled[2].value : [];
    const rawRuns = settled[3].status === 'fulfilled' ? settled[3].value.workflow_runs : [];

    const pulls: GitHubPullRequest[] = rawPulls.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      draft: pr.draft,
      author: pr.user?.login ?? 'unknown',
      updatedAt: pr.updated_at,
      headBranch: pr.head.ref,
      headSha: pr.head.sha,
      ci: unavailable.includes('runs') ? 'unknown' : ciState(pr.head.sha, rawRuns),
    }));
    const issues: GitHubIssue[] = rawIssues
      .filter((issue) => !issue.pull_request)
      .slice(0, 15)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        author: issue.user?.login ?? 'unknown',
        updatedAt: issue.updated_at,
        labels: issue.labels.map((label) => label.name),
      }));
    const milestones: GitHubMilestone[] = rawMilestones.map((milestone) => ({
      number: milestone.number,
      title: milestone.title,
      url: milestone.html_url,
      openIssues: milestone.open_issues,
      closedIssues: milestone.closed_issues,
      dueOn: milestone.due_on,
    }));
    const runs: GitHubWorkflowRun[] = rawRuns.slice(0, 15).map((run) => ({
      id: run.id,
      name: run.name,
      url: run.html_url,
      branch: run.head_branch ?? 'unknown',
      headSha: run.head_sha,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
    }));

    return {
      repository,
      repositories,
      repositoryUrl: info.html_url,
      description: info.description,
      defaultBranch: info.default_branch,
      fetchedAt: new Date().toISOString(),
      pulls,
      issues,
      milestones,
      runs,
      unavailable,
    };
  }
}
