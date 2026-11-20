export type WorktreePlanState = 'pending' | 'acknowledged' | 'revoked' | 'expired';
export type WorktreeAuditEvent = 'created' | 'acknowledged' | 'revoked';

export interface WorktreeAuditEntry {
  event: WorktreeAuditEvent;
  timestamp: string;
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
  executionEnabled: false;
  worktreeCreated: false;
}
