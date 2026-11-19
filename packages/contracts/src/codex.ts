export type CodexConnectionState = 'disconnected' | 'connecting' | 'ready' | 'error';

export interface CodexConnectionStatus {
  state: CodexConnectionState;
  message: string;
  connectedAt: string | null;
}

export type CodexTurnState =
  'idle' | 'starting' | 'streaming' | 'completed' | 'failed' | 'interrupted';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  state: 'completed' | 'failed' | 'interrupted';
}

export interface ChatTurnSnapshot {
  state: CodexTurnState;
  draft: string;
  error: string | null;
}

export interface ChatSnapshot {
  sessionId: string;
  messages: ChatMessage[];
  turn: ChatTurnSnapshot;
}

export interface ChatStreamEvent {
  kind: 'snapshot' | 'progress' | 'refresh' | 'ping';
  snapshot?: ChatSnapshot;
  turn?: ChatTurnSnapshot;
}

export interface CodexSessionBinding {
  sessionId: string;
  threadId: string;
  reused: boolean;
  connection: CodexConnectionStatus;
}
