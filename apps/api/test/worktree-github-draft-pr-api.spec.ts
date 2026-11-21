import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  verifyPublishedRemoteTask,
  assertNoExistingTaskPr,
  createExactDraftPr,
  type RemoteTaskBranch,
} from '../src/worktree/worktree-github-draft-pr-api.js';

const branch = 'devhub/task-' + 'a'.repeat(32);
const sha = 'b'.repeat(40);
const parent = 'c'.repeat(40);
const title = 'fix(api): add safe draft PR flow';
const task: RemoteTaskBranch = { branch, commitSha: sha, parentSha: parent, title };
const pr = {
  number: 70,
  html_url: 'https://github.com/sauron9521/gym-dev-hub/pull/70',
  state: 'open',
  draft: true,
  title,
  head: { ref: branch, sha },
  base: { ref: 'main' },
};
type MockOptions = {
  existing?: boolean;
  wrongHead?: boolean;
  ahead?: number;
  oldSha?: boolean;
  nondraft?: boolean;
  failPost?: boolean;
  lostVerify?: boolean;
};
function githubMock(options: MockOptions = {}) {
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
  let created = false;
  const mock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ path: u.pathname + u.search, method, body });
    const respond = (status: number, data: object) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
    });
    if (
      u.pathname.endsWith('/git/ref/heads/' + 'devhub%2Ftask-' + 'a'.repeat(32)) ||
      decodeURIComponent(u.pathname).endsWith('/git/ref/heads/' + branch)
    ) {
      return respond(200, {
        ref: 'refs/heads/' + branch,
        object: { sha: options.wrongHead ? 'f'.repeat(40) : sha },
      });
    }
    if (u.pathname.endsWith('/git/ref/heads/main')) {
      return respond(200, { ref: 'refs/heads/main', object: { sha: 'd'.repeat(40) } });
    }
    if (u.pathname.includes('/compare/main...')) {
      return respond(200, {
        ahead_by: options.ahead ?? 1,
        commits: [{ sha: options.oldSha ? 'e'.repeat(40) : sha }],
      });
    }
    if (u.pathname.endsWith('/pulls') && method === 'GET') {
      return respond(200, options.existing || created ? [pr] : []);
    }
    if (u.pathname.endsWith('/pulls') && method === 'POST') {
      if (options.failPost) return respond(422, {});
      created = true;
      return respond(201, { ...pr, draft: !options.nondraft });
    }
    if (u.pathname.endsWith('/pulls/70')) {
      return respond(
        200,
        options.lostVerify ? { ...pr, head: { ...pr.head, sha: 'f'.repeat(40) } } : pr,
      );
    }
    throw Error('Unexpected mocked GitHub URL ' + u.pathname);
  });
  vi.stubGlobal('fetch', mock);
  return { calls, isCreated: () => created };
}

describe('fixed GitHub Draft PR API', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('creates precisely one Draft PR from pinned task SHA to main; no merge/update endpoints', async () => {
    const mock = githubMock();
    let lastCheck = 0;
    let attempted = 0;
    const result = await createExactDraftPr(
      task,
      'test-repo-specific-token',
      async () => {
        lastCheck++;
      },
      () => {
        attempted++;
      },
    );
    expect(result).toMatchObject({
      number: 70,
      draft: true,
      headBranch: branch,
      headSha: sha,
      baseBranch: 'main',
    });
    expect(lastCheck).toBe(1);
    expect(attempted).toBe(1);
    expect(mock.isCreated()).toBe(true);
    const writes = mock.calls.filter((x) => x.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/repos/sauron9521/gym-dev-hub/pulls');
    expect(writes[0]?.body).toMatchObject({
      draft: true,
      head: branch,
      base: 'main',
      title,
      maintainer_can_modify: false,
    });
    expect(
      mock.calls.some(
        (x) => x.method === 'PATCH' || x.path.includes('/merge') || x.path.includes('/git/refs'),
      ),
    ).toBe(false);
    expect(mock.calls.at(-1)?.path).toBe('/repos/sauron9521/gym-dev-hub/pulls/70');
  });

  it('refuses a duplicate (including closed PRs) before any remote write', async () => {
    const mock = githubMock({ existing: true });
    await expect(
      createExactDraftPr(
        task,
        'token',
        async () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow('already exists');
    expect(mock.calls.every((x) => x.method === 'GET')).toBe(true);
    expect(mock.calls.find((x) => x.path.includes('/pulls?'))?.path).toContain('state=all');
  });

  it('refuses changed remote SHA or a task that is no longer one ahead of main', async () => {
    for (const opts of [{ wrongHead: true }, { ahead: 2 }, { oldSha: true }]) {
      const mock = githubMock(opts);
      await expect(verifyPublishedRemoteTask(task, 'token')).rejects.toThrow();
      expect(mock.calls.every((x) => x.method === 'GET')).toBe(true);
    }
  });

  it('refuses non-task branch names or rewritten SHA/subject in request', async () => {
    for (const value of [
      { branch: 'main' },
      { branch: 'devhub/task-../../main' },
      { commitSha: 'f'.repeat(10) },
      { title: 'fix(api): unsafe\nmalicious body' },
    ]) {
      const mock = githubMock();
      await expect(
        createExactDraftPr(
          { ...task, ...value },
          'token',
          async () => undefined,
          () => undefined,
        ),
      ).rejects.toThrow('Unsupported');
      expect(mock.calls).toHaveLength(0);
    }
  });

  it('requires explicit final check and rechecks remote just before POST', async () => {
    const mock = githubMock();
    let attempted = false;
    await expect(
      createExactDraftPr(
        task,
        'token',
        async () => {
          throw Error('local audit changed during review');
        },
        () => {
          attempted = true;
        },
      ),
    ).rejects.toThrow('audit changed');
    expect(attempted).toBe(false);
    expect(mock.calls.every((x) => x.method === 'GET')).toBe(true);
  });

  it('marks attempted before network error and never retries POST /pulls', async () => {
    const mock = githubMock({ failPost: true });
    let attempted = false;
    await expect(
      createExactDraftPr(
        task,
        'token',
        async () => undefined,
        () => {
          attempted = true;
        },
      ),
    ).rejects.toThrow('GitHub Draft PR operation');
    expect(attempted).toBe(true);
    expect(mock.calls.filter((x) => x.method === 'POST')).toHaveLength(1);
  });

  it('does not report success if GitHub responds with nondraft or changed PR HEAD', async () => {
    for (const opts of [{ nondraft: true }, { lostVerify: true }]) {
      const mock = githubMock(opts);
      await expect(
        createExactDraftPr(
          task,
          'token',
          async () => undefined,
          () => undefined,
        ),
      ).rejects.toThrow('unexpected GitHub Draft PR');
      expect(mock.calls.filter((x) => x.method === 'POST')).toHaveLength(1);
    }
  });

  it('separate duplicate check checks full state before publishing', async () => {
    const mock = githubMock();
    await assertNoExistingTaskPr(branch, 'token');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.path).toContain('head=sauron9521%3Adevhub%2Ftask-');
  });
});
