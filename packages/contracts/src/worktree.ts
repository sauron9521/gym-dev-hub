export type WorktreePlanState =
  'pending' | 'acknowledged' | 'revoked' | 'expired' | 'creating' | 'created' | 'failed' | 'hydrating' | 'hydrated' | 'hydrate-failed';
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

export interface WorktreeHydrationInspection {
  state: 'ready' | 'blocked' | 'hydrated' | 'manual-review';
  fileCount: number;
  totalBytes: number;
  fingerprint: string | null;
  message: string;
  executionEnabled: false;
}

export interface WorktreeHydrationGrant {
  grantToken: string;
  expiresAt: string;
  fileCount: number;
  totalBytes: number;
  purpose: 'HYDRATE_SAFE_BLOBS_ONLY';
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
  treeFingerprint?: string;
  hydratedFileCount?: number;
  hydratedBytes?: number;
  executionEnabled: false;
  worktreeCreated: boolean;
}
