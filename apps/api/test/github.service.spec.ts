import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubService } from '../src/github/github.service';

const repo = {
  html_url: 'https://github.com/sauron9521/gym-dev-hub',
  description: 'Development tools',
  default_branch: 'main',
};
const pull = {
  number: 7,
  title: 'Add dashboard',
  html_url: 'https://github.com/sauron9521/gym-dev-hub/pull/7',
  draft: false,
  user: { login: 'maintainer' },
  updated_at: '2026-11-19T10:00:00Z',
  head: { ref: 'feat/dashboard', sha: 'abc123' },
};
const issue = {
  number: 8,
  title: 'Fix UX',
  html_url: 'https://github.com/sauron9521/gym-dev-hub/issues/8',
  user: { login: 'maintainer' },
  updated_at: '2026-11-19T10:00:00Z',
  labels: [{ name: 'ux' }],
};
const run = {
  id: 33,
  name: 'CI',
  html_url: 'https://github.com/sauron9521/gym-dev-hub/actions/runs/33',
  head_branch: 'feat/dashboard',
  head_sha: 'abc123',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-19T10:00:00Z',
};

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GitHubService dashboard', () => {
  beforeEach(() => {
    process.env.GITHUB_REPOSITORIES = 'sauron9521/gym-dev-hub,sauron9521/gym-platform';
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_REPOSITORIES;
    delete process.env.GITHUB_TOKEN;
  });

  it('lists PRs, filters PR entries out of issues, and matches Actions by SHA', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/pulls')) return response([pull]);
      if (url.pathname.endsWith('/issues'))
        return response([{ ...issue, pull_request: {} }, issue]);
      if (url.pathname.endsWith('/milestones')) {
        return response([
          {
            number: 2,
            title: 'M01',
            html_url: 'https://github.com/m',
            open_issues: 1,
            closed_issues: 4,
            due_on: null,
          },
        ]);
      }
      if (url.pathname.endsWith('/actions/runs')) return response({ workflow_runs: [run] });
      return response(repo);
    });
    vi.stubGlobal('fetch', fetchMock);

    const overview = await new GitHubService().getDashboard('sauron9521/gym-dev-hub');

    expect(overview.pulls[0]).toMatchObject({ number: 7, ci: 'success' });
    expect(overview.issues).toHaveLength(1);
    expect(overview.issues[0].number).toBe(8);
    expect(overview.milestones[0].closedIssues).toBe(4);
    expect(overview.runs).toHaveLength(1);
    expect(overview.unavailable).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('rejects repositories outside the allowlist without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new GitHubService().getDashboard('attacker/private')).rejects.toThrow(
      'Репозиторій не дозволений',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows partial sections as unavailable instead of reporting zero items', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const path = new URL(input).pathname;
        if (path.endsWith('/pulls')) return response([pull]);
        if (path.endsWith('/issues')) return response([], 403);
        if (path.endsWith('/milestones')) return response([]);
        if (path.endsWith('/actions/runs')) return response({ workflow_runs: [] });
        return response(repo);
      }),
    );
    const result = await new GitHubService().getDashboard();
    expect(result.unavailable).toEqual(['issues']);
    expect(result.pulls[0].ci).toBe('unknown');
  });

  it('does not leak upstream error details when a repository is inaccessible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ message: 'sensitive message' }, 404)),
    );
    await expect(new GitHubService().getDashboard()).rejects.toThrow(
      'Не вдалося завантажити репозиторій',
    );
  });
});
