export type GitHubCIState = 'success' | 'failure' | 'pending' | 'unknown';
export type GitHubSection = 'pulls' | 'issues' | 'milestones' | 'runs';

export interface GitHubPullRequest {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  author: string;
  updatedAt: string;
  headBranch: string;
  headSha: string;
  ci: GitHubCIState;
}

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: string;
  labels: string[];
}

export interface GitHubMilestone {
  number: number;
  title: string;
  url: string;
  openIssues: number;
  closedIssues: number;
  dueOn: string | null;
}

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  url: string;
  branch: string;
  headSha: string;
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
}

export interface GitHubDashboard {
  repository: string;
  repositories: string[];
  repositoryUrl: string;
  description: string | null;
  defaultBranch: string;
  fetchedAt: string;
  pulls: GitHubPullRequest[];
  issues: GitHubIssue[];
  milestones: GitHubMilestone[];
  runs: GitHubWorkflowRun[];
  unavailable: GitHubSection[];
}
