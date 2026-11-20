export type BoundaryState = 'not-checked' | 'running' | 'passed' | 'failed' | 'unavailable';

export interface ExecutionBoundaryStatus {
  state: BoundaryState;
  checkedAt: string | null;
  message: string;
  mode: 'docker-linux-preflight';
  agentExecutionEnabled: false;
  policy: {
    image: string;
    network: 'none';
    rootFilesystem: 'read-only';
    user: 'unprivileged';
    capabilities: 'none';
    privileges: 'no-new-privileges';
    hostMounts: 'none';
    dockerSocket: 'not-mounted';
    memoryMb: 128;
    cpus: 0.5;
    pids: 32;
  };
}
