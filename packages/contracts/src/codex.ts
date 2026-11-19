export type CodexConnectionState = 'disconnected' | 'connecting' | 'ready' | 'error';

export interface CodexConnectionStatus {
  state: CodexConnectionState;
  message: string;
  connectedAt: string | null;
}

export interface CodexSessionBinding {
  sessionId: string;
  threadId: string;
  reused: boolean;
  connection: CodexConnectionStatus;
}
