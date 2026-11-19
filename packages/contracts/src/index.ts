export interface HealthResponse {
  status: 'ok';
  service: 'gym-dev-hub-api';
}

export type {
  GitHubCIState,
  GitHubSection,
  GitHubPullRequest,
  GitHubIssue,
  GitHubMilestone,
  GitHubWorkflowRun,
  GitHubDashboard,
} from './github.js';
