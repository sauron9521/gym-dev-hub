export type WorktreePlanState =
  'pending' | 'acknowledged' | 'revoked' | 'expired' | 'creating' | 'created' | 'failed';
export type WorktreeHydrationState = 'running' | 'completed' | 'failed';
export type WorktreeAuditEvent =
  | 'created'
  | 'acknowledged'
  | 'revoked'
  | 'creation-started'
  | 'worktree-created'
  | 'creation-failed'
  | 'hydration-started'
  | 'hydration-completed'
  | 'hydration-failed'
  | 'mount-probe-started'
  | 'mount-probe-verified'
  | 'mount-probe-failed'
  | 'code-read-started'
  | 'code-read-completed'
  | 'code-read-failed'
  | 'tool-run-started'
  | 'tool-run-completed'
  | 'tool-run-failed';

export interface WorktreeAuditEntry {
  event: WorktreeAuditEvent;
  timestamp: string;
}

export interface WorktreeCreationGrant {
  grantToken: string;
  expiresAt: string;
  baseHeadSha: string;
  purpose: 'CREATE_METADATA_ONLY';
}

export interface WorktreeHydrationGrant {
  grantToken: string;
  expiresAt: string;
  baseHeadSha: string;
  purpose: 'WRITE_RAW_GIT_BLOBS_ONLY';
}

export type WorktreeInspectionState = 'ready-for-hydration' | 'needs-review' | 'missing';

export interface WorktreeInspection {
  planId: string;
  sessionId: string;
  state: WorktreeInspectionState;
  targetExists: boolean;
  metadataOnly: boolean;
  fileCount: number;
  totalBytes: number;
  findings: string[];
  checkedAt: string;
  hydrationEnabled: false;
  recoveryIsReadOnly: true;
}

export interface WorktreeMountPreflight {
  sourcePath: string;
  targetPath: '/workspace';
  readOnly: true;
  networkEnabled: false;
  mountEnabled: false;
  executionEnabled: false;
}

export interface WorktreeIntegrityReport {
  planId: string;
  sessionId: string;
  status: 'verified' | 'mismatch' | 'not-ready';
  fileCount: number;
  verifiedBytes: number;
  findings: string[];
  checkedAt: string;
  mount: WorktreeMountPreflight;
}

export interface WorktreeMountGrant {
  grantToken: string;
  expiresAt: string;
  baseHeadSha: string;
  purpose: 'EPHEMERAL_READ_ONLY_WORKER_MOUNT';
}

export interface WorktreeMountProbeResult {
  planId: string;
  sessionId: string;
  state: 'verified';
  checkedAt: string;
  sourcePath: string;
  targetPath: '/workspace';
  readOnly: true;
  networkEnabled: false;
  containerRemoved: true;
  agentExecutionEnabled: false;
}

export interface WorktreeCodeReadGrant {
  grantToken: string;
  filePath: string;
  expiresAt: string;
  baseHeadSha: string;
  purpose: 'READ_ONE_SCOPED_CODE_FILE';
}

export interface WorktreeCodeReadResult {
  sessionId: string;
  planId: string;
  filePath: string;
  content: string;
  checkedAt: string;
  readOnly: true;
  networkEnabled: false;
  containerRemoved: true;
  agentExecutionEnabled: false;
}

export type WorktreeToolCapability = 'SHA256_FILE';

export interface WorktreeToolGrant {
  grantToken: string;
  purpose: 'RUN_FIXED_WORKER_TOOL';
  tool: WorktreeToolCapability;
  filePath: string;
  baseHeadSha: string;
  expiresAt: string;
}

export interface WorktreeToolResult {
  sessionId: string;
  planId: string;
  tool: WorktreeToolCapability;
  filePath: string;
  sha256: string;
  checkedAt: string;
  readOnly: true;
  networkEnabled: false;
  containerRemoved: true;
  arbitraryCommandExecutionEnabled: false;
  repositoryCodeExecutionEnabled: false;
}

export interface WorktreePlan {
  id: string;
  sessionId: string;
  repository: string;
  sourcePath: string;
  targetPath: string;
  proposedBranch: string;
  fingerprint: string;
  state: WorktreePlanState;
  createdAt: string;
  expiresAt: string | null;
  history: WorktreeAuditEntry[];
  baseHeadSha?: string;
  executionEnabled: false;
  worktreeCreated: boolean;
  hydrationState?: WorktreeHydrationState;
  hydrationFiles?: number;
  hydrationBytes?: number;
}

/** Non-authorizing, read-only server revalidation of a proposed one-file diff. */
export interface WorktreePatchPreflightResult {
  sessionId: string;
  planId: string;
  filePath: string;
  sourceCommit: string;
  fingerprint: string;
  checkedAt: string;
  sourceSha256: string;
  patchSha256: string;
  proposedSha256: string;
  added: number;
  removed: number;
  integrity: 'verified';
  writeEnabled: false;
  authorizationGranted: false;
  readOnly: true;
}

/** Single-use local operator capability, never a general workspace permission. */
export interface WorktreePatchApplyGrant {
  grantToken: string;
  grantId: string;
  expiresAt: string;
  filePath: string;
  sourceCommit: string;
  patchSha256: string;
  proposedSha256: string;
  purpose: 'WRITE_ONE_APPROVED_WORKTREE_FILE';
}

export interface WorktreePatchApplyResult {
  sessionId: string;
  planId: string;
  grantId: string;
  filePath: string;
  sourceCommit: string;
  sourceSha256: string;
  proposedSha256: string;
  appliedAt: string;
  status: 'applied';
  mergeEnabled: false;
  githubPushEnabled: false;
}

/** Read-only post-apply Git snapshot; every response is informational, not permission. */
export interface WorktreePostApplyReview {
  sessionId: string;
  planId: string;
  grantId: string;
  sourceCommit: string;
  filePath: string;
  sourceSha256: string;
  proposedSha256: string;
  checkedAt: string;
  status: 'verified';
  changedFiles: 1;
  trackedFiles: number;
  diff: string;
  recommendedChecks: string[];
  readOnly: true;
  testsExecuted: false;
  commitCreated: false;
  pushEnabled: false;
  mergeEnabled: false;
}

export type WorktreePatchCheckRecipe = 'API_TYPECHECK' | 'API_TEST' | 'WEB_TYPECHECK' | 'WEB_TEST';

export interface WorktreePatchCheckGrant {
  grantId: string;
  grantToken: string;
  recipeId: WorktreePatchCheckRecipe;
  filePath: string;
  proposedSha256: string;
  expiresAt: string;
  purpose: 'AUTHORIZE_ONE_FIXED_POST_APPLY_DOCKER_CHECK';
}

export interface WorktreePatchCheckResult {
  runId: string;
  grantId: string;
  recipeId: WorktreePatchCheckRecipe;
  filePath: string;
  sourceCommit: string;
  proposedSha256: string;
  status: 'passed';
  checkedAt: string;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  containerRemoved: true;
  readOnlySource: true;
  networkEnabled: false;
  arbitraryCommandsEnabled: false;
  commitCreated: false;
  pushEnabled: false;
  mergeEnabled: false;
}

export interface WorktreePatchCheckCancel {
  runId: string;
  status: 'cancel-requested';
}

/** Sanitized read-only projection of fixed Docker check audit events. */
export type WorktreePatchCheckHistoryStatus =
  | 'authorized'
  | 'expired'
  | 'running'
  | 'cancel-requested'
  | 'passed'
  | 'failed'
  | 'canceled'
  | 'interrupted';

export interface WorktreePatchCheckHistoryEntry {
  grantId: string;
  runId: string | null;
  recipeId: WorktreePatchCheckRecipe;
  sourceCommit: string;
  proposedSha256: string;
  filePathSha256: string;
  status: WorktreePatchCheckHistoryStatus;
  authorizedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  stdoutBytes: number | null;
  stderrBytes: number | null;
}

export interface WorktreePatchCheckHistory {
  sessionId: string;
  planId: string;
  checkedAt: string;
  total: number;
  limited: boolean;
  items: WorktreePatchCheckHistoryEntry[];
  readOnly: true;
  rawLogsAvailable: false;
  commandsEnabled: false;
  commitEnabled: false;
  pushEnabled: false;
  mergeEnabled: false;
}
