import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import type {
  GitHubCIState,
  PullCheck,
  PullReadiness,
  RequiredPolicy,
} from '@gym-dev-hub/contracts';
import { GitHubService } from './github.service.js';
import { evaluateReadiness } from './readiness-evaluator.js';

interface PullRaw {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  state: string;
  head: { sha: string };
  base: { ref: string };
  mergeable: boolean | null;
  mergeable_state: string;
}
interface CheckRunRaw {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  details_url: string | null;
  app: { id: number; slug: string } | null;
}
interface CheckRunsRaw {
  total_count: number;
  check_runs: CheckRunRaw[];
}
interface StatusRaw {
  context: string;
  state: string;
  description: string | null;
  target_url: string | null;
}
interface CommitStatusRaw {
  statuses: StatusRaw[];
}
interface BranchRaw {
  protected: boolean;
}
interface ProtectionRaw {
  contexts?: string[];
  checks?: Array<{ context: string; app_id: number | null }>;
}

function checkState(status: string, conclusion: string | null): GitHubCIState {
  if (status !== 'completed') return 'pending';
  if (['success', 'neutral', 'skipped'].includes(conclusion ?? '')) return 'success';
  if (
    ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(
      conclusion ?? '',
    )
  ) {
    return 'failure';
  }
  return 'unknown';
}

function statusState(state: string): GitHubCIState {
  if (state === 'success') return 'success';
  if (state === 'pending') return 'pending';
  if (state === 'failure' || state === 'error') return 'failure';
  return 'unknown';
}

@Injectable()
export class ReadinessService {
  private readonly cache = new Map<string, { expiry: number; data: PullReadiness }>();
  private readonly inFlight = new Map<string, Promise<PullReadiness>>();

  constructor(private readonly github: GitHubService) {}

  async getReadiness(repository: string | undefined, numberInput: string | undefined) {
    const name = this.github.assertAllowedRepository(repository);
    const number = Number(numberInput);
    if (!numberInput || !Number.isSafeInteger(number) || number <= 0) {
      throw new BadRequestException('Некоректний номер PR');
    }
    const key = `${name}#${number}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiry > Date.now()) return cached.data;

    const running = this.inFlight.get(key);
    if (running) return running;

    const operation = this.fetchReadiness(name, number)
      .then((data) => {
        // Bounded, short-lived cache reduces GitHub API calls but must not be
        // considered a current merge decision; every result carries the head SHA.
        if (this.cache.size >= 60) this.cache.clear();
        this.cache.set(key, { expiry: Date.now() + 20_000, data });
        return data;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, operation);
    return operation;
  }

  private async fetchReadiness(repository: string, number: number): Promise<PullReadiness> {
    const [owner, name] = repository.split('/');
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

    let pr: PullRaw;
    try {
      pr = await this.github.request<PullRaw>(`${root}/pulls/${number}`);
    } catch {
      throw new BadGatewayException('GitHub не надав інформацію про PR або доступ обмежений.');
    }
    if (pr.state !== 'open') {
      throw new BadRequestException('Ця перевірка доступна лише для відкритих PR');
    }

    const sha = encodeURIComponent(pr.head.sha);
    const base = encodeURIComponent(pr.base.ref);
    const [checkResult, statusResult, branchResult] = await Promise.allSettled([
      this.github.request<CheckRunsRaw>(`${root}/commits/${sha}/check-runs?per_page=100`),
      this.github.request<CommitStatusRaw>(`${root}/commits/${sha}/status?per_page=100`),
      this.github.request<BranchRaw>(`${root}/branches/${base}`),
    ]);

    const unavailable: PullReadiness['unavailable'] = [];
    const checks: PullCheck[] = [];

    if (checkResult.status === 'fulfilled') {
      // Only the latest attempt for each check and app is considered.
      const byIdentity = new Map<string, CheckRunRaw>();
      for (const run of checkResult.value.check_runs) {
        const key = `${run.name}:${run.app?.id ?? 'none'}`;
        const previous = byIdentity.get(key);
        if (!previous || run.id > previous.id) byIdentity.set(key, run);
      }
      for (const run of byIdentity.values()) {
        checks.push({
          name: run.name,
          source: 'check-run',
          provider: run.app?.slug ?? 'GitHub Checks',
          appId: run.app?.id ?? null,
          state: checkState(run.status, run.conclusion),
          detail: run.conclusion ?? run.status,
          url: run.details_url ?? run.html_url,
        });
      }
      if (checkResult.value.total_count > checkResult.value.check_runs.length) {
        unavailable.push('check-runs');
      }
    } else {
      unavailable.push('check-runs');
    }

    if (statusResult.status === 'fulfilled') {
      const statusByContext = new Map<string, StatusRaw>();
      for (const status of statusResult.value.statuses) {
        if (!statusByContext.has(status.context)) statusByContext.set(status.context, status);
      }
      for (const status of statusByContext.values()) {
        checks.push({
          name: status.context,
          source: 'commit-status',
          provider: 'Commit status',
          appId: null,
          state: statusState(status.state),
          detail: status.description ?? status.state,
          url: status.target_url,
        });
      }
      if (statusResult.value.statuses.length >= 100) {
        // Can't prove completeness of legacy contexts with this bounded request.
        unavailable.push('commit-statuses');
      }
    } else {
      unavailable.push('commit-statuses');
    }

    let policy: RequiredPolicy = 'unavailable';
    let requiredRules: Array<{ name: string; appId: number | null }> = [];

    if (branchResult.status === 'fulfilled' && !branchResult.value.protected) {
      policy = 'none-detected';
    } else if (branchResult.status === 'fulfilled') {
      try {
        const response = await this.github.request<ProtectionRaw>(
          `${root}/branches/${base}/protection/required_status_checks`,
        );
        const rules = new Map<string, { name: string; appId: number | null }>();
        for (const context of response.contexts ?? []) {
          rules.set(`${context}:any`, { name: context, appId: null });
        }
        for (const check of response.checks ?? []) {
          // Checks with a specific app ID must match that exact app.
          const appId = typeof check.app_id === 'number' && check.app_id > 0 ? check.app_id : null;
          if (appId !== null) rules.delete(`${check.context}:any`);
          rules.set(`${check.context}:${appId ?? 'any'}`, { name: check.context, appId });
        }
        requiredRules = [...rules.values()];
        policy = 'classic-required';
      } catch {
        unavailable.push('branch-protection');
      }
    } else {
      unavailable.push('branch-protection');
    }

    return evaluateReadiness({
      repository,
      number,
      title: pr.title,
      url: pr.html_url,
      headSha: pr.head.sha,
      baseBranch: pr.base.ref,
      draft: pr.draft,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
      checks,
      policy,
      requiredRules,
      unavailable,
    });
  }
}
