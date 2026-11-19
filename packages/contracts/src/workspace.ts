export type AgentSessionStatus = 'planned' | 'in-progress' | 'review' | 'completed';

export interface WorkspaceMessage {
  id: string;
  role: 'user';
  content: string;
  createdAt: string;
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  repository: string;
  task: string;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface AgentSession extends AgentSessionSummary {
  messages: WorkspaceMessage[];
}

export interface WorkspaceOverview {
  repositories: string[];
  sessions: AgentSessionSummary[];
}
