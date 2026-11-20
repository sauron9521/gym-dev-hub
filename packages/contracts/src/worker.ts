export type WorkerState = 'not-started' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export interface IsolatedWorkerStatus {
  state: WorkerState;
  message: string;
  containerName: string | null;
  imageId: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  protocolVersion: 1;
  executionEnabled: false;
}
