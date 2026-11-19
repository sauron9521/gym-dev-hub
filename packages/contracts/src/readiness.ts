import type { GitHubCIState } from './github.js';

export type ReadinessVerdict = 'ready-for-review' | 'blocked' | 'pending' | 'unknown';
export type RequiredPolicy = 'classic-required' | 'none-detected' | 'unavailable';
export type CheckSource = 'check-run' | 'commit-status';

export interface PullCheck {
  name: string;
  source: CheckSource;
  provider: string;
  appId: number | null;
  state: GitHubCIState;
  detail: string;
  url: string | null;
}

export interface RequiredCheck {
  name: string;
  appId: number | null;
  state: GitHubCIState;
}

export interface PullReadiness {
  repository: string;
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headSha: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  fetchedAt: string;
  checks: PullCheck[];
  checksState: GitHubCIState;
  policy: RequiredPolicy;
  requiredChecks: RequiredCheck[];
  requiredState: GitHubCIState;
  verdict: ReadinessVerdict;
  reasons: string[];
  unavailable: Array<'check-runs' | 'commit-statuses' | 'branch-protection'>;
}
