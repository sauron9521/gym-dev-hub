export type WorktreePlanState =
  'pending' | 'acknowledged' | 'revoked' | 'expired' | 'creating' | 'created' | 'failed';
export type WorktreeAuditEvent =
  | 'created'
  | 'acknowledged'
  | 'revoked'
  | 'creation-started'
  | 'worktree-created'
  | 'creation-failed';

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
}
