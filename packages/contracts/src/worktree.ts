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
  | 'hydration-failed';

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
