import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubService } from '../src/github/github.service.js';
import { ReadinessService } from '../src/github/readiness.service.js';

const PR = {
  number: 3,
  title: 'Checks',
  html_url: 'https://github.com/sauron9521/gym-dev-hub/pull/3',
  draft: false,
  state: 'open',
  head: { sha: 'd34db33f' },
  base: { ref: 'main' },
  mergeable: true,
  mergeable_state: 'clean',
};
const RUN = {
  id: 123,
  name: 'Verify (Node 24)',
  status: 'completed',
  conclusion: 'success',
  details_url: 'https://github.com/example/check',
  html_url: null,
  app: { id: 42, slug: 'github-actions' },
};

function setup(options?: {
  checks?: boolean;
  statusError?: boolean;
  protected?: boolean;
  pr?: typeof PR;
}) {
  const github = new GitHubService();
  const paths: string[] = [];
  vi.spyOn(github, 'request').mockImplementation(async (path: string) => {
    paths.push(path);
    if (path.endsWith('/pulls/3')) return (options?.pr ?? PR) as never;
    if (path.includes('/check-runs')) {
      if (options?.checks === false) throw new Error('GitHub 403');
      return { total_count: 1, check_runs: [RUN] } as never;
    }
    if (path.includes('/commits/') && path.includes('/status')) {
      if (options?.statusError) throw new Error('GitHub 403');
      return { statuses: [] } as never;
    }
    if (path.includes('/required_status_checks')) {
      return {
        contexts: ['Verify (Node 24)'],
        checks: [{ context: 'Verify (Node 24)', app_id: 42 }],
      } as never;
    }
    if (path.endsWith('/branches/main')) return { protected: options?.protected ?? true } as never;
    throw new Error(`Unexpected request: ${path}`);
  });
  return { github, service: new ReadinessService(github), paths };
}

describe('ReadinessService', () => {
  beforeEach(() => {
    process.env.GITHUB_REPOSITORIES = 'sauron9521/gym-dev-hub,sauron9521/gym-platform';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GITHUB_REPOSITORIES;
  });

  it('uses current PR head SHA for checks and commit statuses, never branch name', async () => {
    const { service, paths } = setup();
    const result = await service.getReadiness('sauron9521/gym-dev-hub', '3');

    expect(paths).toContain(
      '/repos/sauron9521/gym-dev-hub/commits/d34db33f/check-runs?per_page=100',
    );
    expect(paths).toContain('/repos/sauron9521/gym-dev-hub/commits/d34db33f/status?per_page=100');
    expect(result.headSha).toBe('d34db33f');
    expect(result.verdict).toBe('ready-for-review');
    expect(result.requiredChecks[0]).toMatchObject({ name: 'Verify (Node 24)', state: 'success' });
  });

  it('protects the API allowlist and rejects non-numeric PR IDs', async () => {
    const { service, paths } = setup();
    await expect(service.getReadiness('someone/private', '3')).rejects.toThrow('Репозиторій');
    await expect(service.getReadiness('sauron9521/gym-dev-hub', '../3')).rejects.toThrow(
      'Некоректний',
    );
    expect(paths).toHaveLength(0);
  });

  it('does not claim success when check-run access fails', async () => {
    const { service } = setup({ checks: false });
    const result = await service.getReadiness('sauron9521/gym-dev-hub', '3');
    expect(result.unavailable).toContain('check-runs');
    expect(result.verdict).toBe('unknown');
  });

  it('uses a bounded TTL cache and does not request GitHub again within it', async () => {
    const { service, paths } = setup();
    const first = await service.getReadiness('sauron9521/gym-dev-hub', '3');
    const count = paths.length;
    const second = await service.getReadiness('sauron9521/gym-dev-hub', '3');
    expect(second).toBe(first);
    expect(paths.length).toBe(count);
  });

  it('does not declare merged or closed PRs ready for review', async () => {
    const { service } = setup({ pr: { ...PR, state: 'closed' } });
    await expect(service.getReadiness('sauron9521/gym-dev-hub', '3')).rejects.toThrow(
      'відкритих PR',
    );
  });

  it('reports incomplete legacy status data as unavailable', async () => {
    const { service } = setup({ statusError: true });
    const result = await service.getReadiness('sauron9521/gym-dev-hub', '3');
    expect(result.unavailable).toContain('commit-statuses');
    expect(result.verdict).toBe('unknown');
  });

  it('distinguishes no classic protection from unknown protection', async () => {
    const { service } = setup({ protected: false });
    const result = await service.getReadiness('sauron9521/gym-dev-hub', '3');
    expect(result.policy).toBe('none-detected');
    expect(result.requiredChecks).toHaveLength(0);
    expect(result.verdict).toBe('ready-for-review');
  });
});
