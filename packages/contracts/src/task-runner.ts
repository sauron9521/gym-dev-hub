/** A fixed set of recipes for gym-platform only. Client-provided commands are never accepted. */
export type TaskRunnerRecipeId =
  'API_TEST' | 'API_TYPECHECK' | 'API_LINT' | 'WEB_TEST' | 'WEB_TYPECHECK' | 'WEB_LINT';

export interface TaskRunnerPreview {
  sessionId: string;
  planId: string;
  repository: 'sauron9521/gym-platform';
  recipeId: TaskRunnerRecipeId;
  label: string;
  baseHeadSha: string;
  fingerprint: string;
  generatedAt: string;
  /** Exact fixed executable and argv proposed for a future isolated runner. */
  argv: string[];
  workingDirectory: '/workspace';
  /** Future-executor requirements only. NOT evidence that execution is currently possible. */
  proposedBoundary: {
    network: 'none';
    sourceMount: 'read-only';
    writableArea: 'ephemeral-tmpfs';
    uid: 'non-root';
    dockerSocket: false;
    environmentSecrets: false;
    maxDurationSeconds: 600;
    maxMemoryMiB: 2048;
    maxCpus: 2;
    maxPids: 128;
    maxOutputBytes: 65536;
  };
  status: 'preview-only';
  executionEnabled: false;
  approvalGranted: false;
  runnerImageAvailable: false;
  /** Package scripts can execute untrusted repository code. */
  executesUntrustedProjectScripts: true;
  notes: string[];
}


/**
 * A locally authorized, single-use capability for one fixed pinned recipe.
 * PR #29 issues/revokes grants but cannot use them to run source code.
 */
export interface TaskExecutionGrant {
  grantId: string;
  /** Returned once. Never logged, written to disk or accepted as an arbitrary command. */
  grantToken: string;
  recipeId: 'API_TYPECHECK';
  sourceCommit: '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
  sourceTree: '2c140e1e740b3dd8cc7582db726f46b54b73b334';
  sourceManifestSha256: 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';
  fingerprint: string;
  expiresAt: string;
  purpose: 'AUTHORIZE_ONE_PINNED_API_TYPECHECK';
  /** No execution entrypoint exists in this release. */
  executionEnabled: false;
}

export interface TaskExecutionGrantRevocation {
  grantId: string;
  status: 'revoked';
  executionEnabled: false;
}

export interface TaskExecutionGrantReceipt {
  grantId: string;
  recipeId: 'API_TYPECHECK';
  status: 'consumed-no-execution';
  executionEnabled: false;
}
