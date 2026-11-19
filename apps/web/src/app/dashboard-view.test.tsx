import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GitHubDashboard } from '@gym-dev-hub/contracts';
import { DashboardView } from './dashboard-view';

const dashboard: GitHubDashboard = {
  repository: 'sauron9521/gym-dev-hub',
  repositories: ['sauron9521/gym-dev-hub', 'sauron9521/gym-platform'],
  repositoryUrl: 'https://github.com/sauron9521/gym-dev-hub',
  description: 'Development orchestration',
  defaultBranch: 'main',
  fetchedAt: '2026-11-19T20:00:00Z',
  pulls: [
    {
      number: 7,
      title: 'Dashboard UI',
      url: 'https://github.com/sauron9521/gym-dev-hub/pull/7',
      draft: false,
      author: 'maintainer',
      updatedAt: '2026-11-19T20:00:00Z',
      headBranch: 'feat/dashboard',
      headSha: 'aabb',
      ci: 'success',
    },
  ],
  issues: [
    {
      number: 8,
      title: 'Add worker',
      url: 'https://github.com/sauron9521/gym-dev-hub/issues/8',
      author: 'maintainer',
      updatedAt: '2026-11-19T20:00:00Z',
      labels: ['backend'],
    },
  ],
  milestones: [
    {
      number: 1,
      title: 'M01',
      url: 'https://github.com/example/milestone',
      openIssues: 2,
      closedIssues: 3,
      dueOn: null,
    },
  ],
  runs: [
    {
      id: 101,
      name: 'CI',
      url: 'https://github.com/example/actions/101',
      branch: 'feat/dashboard',
      headSha: 'aabb',
      event: 'pull_request',
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-11-19T20:00:00Z',
    },
  ],
  unavailable: [],
};

describe('GitHub Dashboard', () => {
  it('renders read-only GitHub data and repository navigation', () => {
    const markup = renderToStaticMarkup(<DashboardView dashboard={dashboard} />);
    expect(markup).toContain('Контроль розробки');
    expect(markup).toContain('Dashboard UI');
    expect(markup).toContain('Перевірити');
    expect(markup).toContain('/pr/7?repository=sauron9521%2Fgym-dev-hub');
    expect(markup).toContain('Add worker');
    expect(markup).toContain('CI пройшов');
    expect(markup).toContain('Milestones');
    expect(markup).toContain('gym-platform');
  });

  it('shows API unavailability rather than invented data', () => {
    const markup = renderToStaticMarkup(<DashboardView dashboard={null} error="API offline" />);
    expect(markup).toContain('API offline');
    expect(markup).toContain('pnpm dev');
  });

  it('does not claim a failed GitHub section is empty', () => {
    const markup = renderToStaticMarkup(
      <DashboardView dashboard={{ ...dashboard, issues: [], unavailable: ['issues'] }} />,
    );
    expect(markup).toContain('GitHub не надав дані');
    expect(markup).toContain('—');
  });
});
