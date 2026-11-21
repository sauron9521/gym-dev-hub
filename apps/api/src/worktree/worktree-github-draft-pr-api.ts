/**
 * Fixed GitHub repo, fixed main base, new DRAFT PR only.
 * No update, merge, branch writes, arbitrary URLs or user-supplied API paths.
 */
const ROOT = 'https://api.github.com/repos/sauron9521/gym-dev-hub';
const TASK = /^devhub\/task-[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{40}$/;
const TITLE =
  /^(feat|fix|refactor|docs|test|chore|perf|build|ci|style)(\([a-z][a-z0-9-]{0,29}\))?: [^\r\n]{3,70}$/;
const HEAD_OWNER = 'sauron9521';

export interface RemoteTaskBranch {
  branch: string;
  commitSha: string;
  parentSha: string;
  title: string;
}
export interface GitHubDraftPr {
  number: number;
  url: string;
  title: string;
  draft: true;
  headSha: string;
  headBranch: string;
  baseBranch: 'main';
}

interface RefRaw {
  ref?: string;
  object?: { sha?: string };
}
interface PrRaw {
  number?: number;
  html_url?: string;
  title?: string;
  draft?: boolean;
  state?: string;
  head?: { sha?: string; ref?: string };
  base?: { ref?: string };
}
export class DraftPrGitHubError extends Error {
  constructor(
    readonly action: string,
    readonly status: number,
  ) {
    super('GitHub Draft PR operation failed');
  }
}
async function request<T>(
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: object,
): Promise<T> {
  if (
    !path.startsWith('/') ||
    path.split('/').some((part) => part === '..') ||
    path.includes('#') ||
    /[\r\n]/.test(path)
  )
    throw new Error('Unexpected GitHub API path');
  const response = await fetch(ROOT + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gym-dev-hub-draft-pr',
      Authorization: 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new DraftPrGitHubError(method + ' ' + path, response.status);
  return (await response.json()) as T;
}
function checked(task: RemoteTaskBranch): void {
  if (
    !TASK.test(task.branch) ||
    !SHA.test(task.commitSha) ||
    !SHA.test(task.parentSha) ||
    task.commitSha === task.parentSha ||
    task.title.length < 10 ||
    task.title.length > 72 ||
    !TITLE.test(task.title)
  )
    throw new Error('Unsupported audited Draft PR metadata');
}
export async function verifyPublishedRemoteTask(
  task: RemoteTaskBranch,
  token: string,
): Promise<void> {
  checked(task);
  const branch = encodeURIComponent(task.branch);
  const ref = await request<RefRaw>(token, 'GET', '/git/ref/heads/' + branch);
  if (ref.ref !== 'refs/heads/' + task.branch || ref.object?.sha !== task.commitSha) {
    throw new Error('Remote task branch no longer equals audited local commit');
  }
  const main = await request<RefRaw>(token, 'GET', '/git/ref/heads/main');
  if (main.ref !== 'refs/heads/main' || !SHA.test(main.object?.sha ?? '')) {
    throw new Error('GitHub main ref could not be verified');
  }
  // Enforce a single relevant commit ahead of main and a common ancestor
  // without requiring main to stay at the old baseline.
  const compare = await request<{
    ahead_by?: number;
    commits?: Array<{ sha?: string }>;
  }>(token, 'GET', '/compare/main...' + branch);
  if (
    compare.ahead_by !== 1 ||
    compare.commits?.length !== 1 ||
    compare.commits[0]?.sha !== task.commitSha
  ) {
    throw new Error('Remote task branch no longer has exactly one proposed commit');
  }
}
export async function assertNoExistingTaskPr(branch: string, token: string): Promise<void> {
  if (!TASK.test(branch)) throw new Error('Unexpected GitHub PR head branch');
  const query = new URLSearchParams({
    state: 'all',
    head: HEAD_OWNER + ':' + branch,
    per_page: '100',
  });
  const pulls = await request<PrRaw[]>(token, 'GET', '/pulls?' + query.toString());
  if (
    !Array.isArray(pulls) ||
    pulls.length >= 100 ||
    pulls.some((pr) => pr.head?.ref === branch || pr.number !== undefined)
  ) {
    throw new Error('Draft PR already exists or duplicate check is not exhaustive');
  }
}

function inspectDraft(value: PrRaw, task: RemoteTaskBranch): GitHubDraftPr {
  if (
    !Number.isSafeInteger(value.number) ||
    (value.number ?? 0) < 1 ||
    !value.html_url?.startsWith(ROOT.replace('api.github.com/repos/', 'github.com/') + '/pull/') ||
    value.draft !== true ||
    value.state !== 'open' ||
    value.title !== task.title ||
    value.head?.sha !== task.commitSha ||
    value.head?.ref !== task.branch ||
    value.base?.ref !== 'main'
  ) {
    throw new Error('Unconfirmed or unexpected GitHub Draft PR result');
  }
  return {
    number: value.number!,
    url: value.html_url,
    title: value.title,
    draft: true,
    headSha: task.commitSha,
    headBranch: task.branch,
    baseBranch: 'main',
  };
}

export async function createExactDraftPr(
  task: RemoteTaskBranch,
  token: string,
  beforeCreate: () => Promise<void>,
  markAttempted: () => void,
): Promise<GitHubDraftPr> {
  checked(task);
  await verifyPublishedRemoteTask(task, token);
  await assertNoExistingTaskPr(task.branch, token);
  await beforeCreate();
  await verifyPublishedRemoteTask(task, token);
  await assertNoExistingTaskPr(task.branch, token);
  // Once POST /pulls is attempted, a lost response is ambiguous: no retry.
  markAttempted();
  const raw = await request<PrRaw>(token, 'POST', '/pulls', {
    title: task.title,
    head: task.branch,
    base: 'main',
    draft: true,
    maintainer_can_modify: false,
    body: [
      '## Review scope',
      '',
      'Gym Dev Hub manually reviewed this single-file change.',
      'Source: an independently authorized local commit and published task branch.',
      'Commit SHA: ' + task.commitSha,
      '',
      'This is a **Draft PR**. Check CI and review changes in GitHub.',
      'Do not merge until the repository owner approves it.',
    ].join('\n'),
  });
  const result = inspectDraft(raw, task);
  const confirmed = await request<PrRaw>(token, 'GET', '/pulls/' + result.number);
  const result2 = inspectDraft(confirmed, task);
  if (result2.number !== result.number || result2.url !== result.url) {
    throw new Error('GitHub Draft PR could not be reverified');
  }
  return result;
}
