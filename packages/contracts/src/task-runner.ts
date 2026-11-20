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
