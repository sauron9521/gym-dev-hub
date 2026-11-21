/** Read-only local operator smoke preflight. Never grants execution authority. */
export type WorkflowGateState = 'configured' | 'blocked' | 'unknown';
export type WorkflowGateId =
  | 'source'
  | 'worktree'
  | 'hydration'
  | 'scoped-read'
  | 'patch-review'
  | 'docker-check'
  | 'candidate'
  | 'local-commit'
  | 'github-publish'
  | 'draft-pr'
  | 'ci';

export interface WorkflowReadinessGate {
  id: WorkflowGateId;
  title: string;
  state: WorkflowGateState;
  /** Environment *key names* only; never values, secrets or token material. */
  missingKeys: string[];
  note: string;
}

export interface WorkflowReadinessReport {
  repository: 'sauron9521/gym-dev-hub';
  checkedAt: string;
  source: {
    localHeadSha: string | null;
    githubMainSha: string | null;
    state: WorkflowGateState;
  };
  gates: WorkflowReadinessGate[];
  configuredCount: number;
  totalCount: number;
  /** Environment and source preconditions only; not a passed E2E smoke. */
  preconditionsSatisfied: boolean;
  readOnly: true;
  mutatingCommandsExecuted: false;
  writesPerformed: false;
  githubPermissionsVerified: false;
  dockerExecutionVerified: false;
  endToEndVerified: false;
}
