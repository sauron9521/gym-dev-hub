import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commitAudit, type CommitAuditIdentity } from '../src/worktree/worktree-commit-audit.js';
import { fixedOneFileCommit } from '../src/worktree/worktree-fixed-commit.js';
import {
  inspectLocalCommitForPush,
  assertGitHubBranchAbsent,
  publishExactCommit,
  type VerifiedPublishedCommit,
} from '../src/worktree/worktree-github-publisher.js';

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN_ID = '00000000-0000-4000-8000-000000000123';
const FILE = 'apps/api/src/main.ts';
const BRANCH = 'devhub/task-' + 'f'.repeat(32);
const identity = { name: 'Fixture Author', email: 'fixture@example.invalid' };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
/** Emulate GitHub's raw Git commit object for a fixed Git Data API payload. */
function gitHubCommitHash(input: Record<string, unknown>): string {
  const person = (value: unknown) => {
    const person = value as { name: string; email: string; date: string };
    const match = /([+-]\d\d):(\d\d)$/.exec(person.date);
    if (!match) throw new Error('Expected explicit ISO-8601 Git timezone');
    return `${person.name} <${person.email}> ${Math.floor(Date.parse(person.date) / 1000)} ${match[1]}${match[2]}`;
  };
  const body = Buffer.from(
    `tree ${input.tree}\nparent ${(input.parents as string[])[0]}\nauthor ${person(input.author)}\ncommitter ${person(input.committer)}\n\n${input.message}`,
  );
  return createHash('sha1')
    .update(Buffer.from(`commit ${body.length}\0`))
    .update(body)
    .digest('hex');
}

function git(cwd: string, ...args: string[]): string {
  const p = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    shell: false,
    timeout: 15000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    },
  });
  if (p.status !== 0) throw Error('Disposable Git fixture failed ' + args[0]);
  return p.stdout.trim();
}

describe('GitHub publish exact local Git commit via create-ref-only API', () => {
  let root: string;
  let source: string;
  let task: string;
  let evidence: VerifiedPublishedCommit;
  let plan: Parameters<typeof inspectLocalCommitForPush>[0];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'github-push-fixture-'));
    source = join(root, 'source');
    task = join(root, 'worktree');
    await mkdir(join(source, 'apps/api/src'), { recursive: true });
    await mkdir(join(root, 'scratch'), { recursive: true });
    git(source, 'init', '-q');
    await writeFile(join(source, FILE), 'export const old = true;\n');
    await writeFile(join(source, 'README.md'), 'unchanged\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'fixture');
    const original = git(source, 'rev-parse', 'HEAD');
    git(source, 'worktree', 'add', '-q', '-b', BRANCH, task, 'HEAD');
    const updated = 'export const old = false;\n';
    await writeFile(join(task, FILE), updated);
    const committed = await fixedOneFileCommit(
      {
        worktree: task,
        branch: BRANCH,
        baseSha: original,
        path: FILE,
        proposedSha256: hash(updated),
        subject: 'fix(api): publish approved exact commit',
        identity,
        temporaryRoot: join(root, 'scratch'),
      },
      async () => undefined,
      () => undefined,
    );
    process.env.DEV_HUB_COMMIT_STATE_DIR = join(root, 'audit');
    const audit: CommitAuditIdentity = {
      grantId: randomUUID(),
      runId: null,
      sessionId: SESSION,
      planId: PLAN_ID,
      candidateSha256: hash('candidate'),
      sourceCommit: original,
      filePathSha256: hash(FILE),
      subjectSha256: hash('fix(api): publish approved exact commit'),
    };
    const runId = randomUUID();
    await commitAudit('issued', audit);
    await commitAudit('attempted', { ...audit, runId });
    await commitAudit('committed', { ...audit, runId }, committed.commitSha);
    plan = {
      repository: 'sauron9521/gym-dev-hub',
      targetPath: task,
      sourcePath: source,
      proposedBranch: BRANCH,
      baseHeadSha: original,
    } as never;
    evidence = await inspectLocalCommitForPush(plan, SESSION, PLAN_ID, committed.commitSha);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.DEV_HUB_COMMIT_STATE_DIR;
    await rm(root, { recursive: true, force: true });
  });

  function githubMock(
    options: {
      alreadyExists?: boolean;
      wrongBlob?: boolean;
      wrongTree?: boolean;
      wrongCommit?: boolean;
      failRefCreation?: boolean;
      lostRefConfirmation?: boolean;
    } = {},
  ) {
    const requests: Array<{ url: string; method: string; payload?: Record<string, unknown> }> = [];
    let created = false;
    const make = vi.fn(async (url: string, init: RequestInit = {}) => {
      const pathname = new URL(url).pathname;
      const method = init.method ?? 'GET';
      const payload = init.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      requests.push({ url: pathname, method, ...(payload ? { payload } : {}) });
      const result = (status: number, json: object) => ({
        status,
        json: async () => json,
      });
      if (pathname.endsWith('/git/ref/heads/' + BRANCH) && method === 'GET') {
        if (options.alreadyExists || (created && !options.lostRefConfirmation)) {
          return result(200, {
            ref: 'refs/heads/' + BRANCH,
            object: { sha: evidence.commitSha },
          });
        }
        return result(404, {});
      }
      if (pathname.endsWith('/git/commits/' + evidence.parentSha))
        return result(200, { sha: evidence.parentSha });
      if (pathname.endsWith('/git/blobs') && method === 'POST')
        return result(201, { sha: options.wrongBlob ? '0'.repeat(40) : evidence.blobSha });
      if (pathname.endsWith('/git/trees') && method === 'POST')
        return result(201, { sha: options.wrongTree ? '0'.repeat(40) : evidence.treeSha });
      if (pathname.endsWith('/git/commits') && method === 'POST')
        return result(201, {
          sha: options.wrongCommit ? '0'.repeat(40) : gitHubCommitHash(payload!),
        });
      if (pathname.endsWith('/git/refs') && method === 'POST') {
        if (options.failRefCreation) return result(422, {});
        created = true;
        return result(201, {
          ref: 'refs/heads/' + BRANCH,
          object: { sha: evidence.commitSha },
        });
      }
      throw Error('Unexpected GitHub API call: ' + method + ' ' + pathname);
    });
    vi.stubGlobal('fetch', make);
    return { requests, make, isCreated: () => created };
  }

  it('matches actual local Git objects, original parent and one existing reviewed file', async () => {
    expect(evidence).toMatchObject({
      branch: BRANCH,
      filePath: FILE,
      parentSha: plan.baseHeadSha,
      subject: 'fix(api): publish approved exact commit',
    });
    expect(evidence.rawContent.toString('utf8')).toBe('export const old = false;\n');
    expect(evidence.blobSha).toMatch(/^[a-f0-9]{40}$/);
    expect(evidence.treeSha).toMatch(/^[a-f0-9]{40}$/);
    expect(evidence.author).toMatchObject(identity);
    expect(evidence.committer).toMatchObject(identity);
  });

  it('only creates a previously absent task branch at exactly the approved commit', async () => {
    const mock = githubMock();
    let reviews = 0;
    let refAttempted = 0;
    await publishExactCommit(
      evidence,
      'mock-token-with-valid-length-1234567890123456',
      async () => {
        reviews++;
      },
      () => {
        refAttempted++;
      },
    );
    expect({ reviews, refAttempted }).toEqual({ reviews: 1, refAttempted: 1 });
    expect(mock.isCreated()).toBe(true);
    expect(
      mock.requests
        .filter((x) => x.method === 'POST')
        .map((x) => x.url.slice(x.url.lastIndexOf('/') + 1)),
    ).toEqual(['blobs', 'trees', 'commits', 'refs']);
    const ref = mock.requests.find((x) => x.url.endsWith('/git/refs'))!;
    expect(ref.payload).toEqual({
      ref: 'refs/heads/' + BRANCH,
      sha: evidence.commitSha,
    });
    expect(mock.requests.every((x) => !x.url.includes('/branches/main'))).toBe(true);
    expect(mock.requests.every((x) => x.method === 'GET' || x.method === 'POST')).toBe(true);
    const tree = mock.requests.find((x) => x.url.endsWith('/git/trees'))!;
    expect(tree.payload).toMatchObject({
      base_tree: evidence.parentTreeSha,
      tree: [
        {
          path: FILE,
          mode: '100644',
          type: 'blob',
          sha: evidence.blobSha,
        },
      ],
    });
    const commit = mock.requests.find(
      (x) => x.method === 'POST' && x.url.endsWith('/git/commits'),
    )!;
    expect(commit.payload).toMatchObject({
      tree: evidence.treeSha,
      message: evidence.subject + '\n',
      parents: [evidence.parentSha],
    });
    expect(gitHubCommitHash(commit.payload!)).toBe(evidence.commitSha);
    // GitHub without the trailing LF creates an unreferenced, mismatching
    // object. The real localhost E2E caught precisely this old behavior.
    expect(gitHubCommitHash({ ...commit.payload, message: evidence.subject })).not.toBe(
      evidence.commitSha,
    );
    expect(git(source, 'rev-parse', 'HEAD')).toBe(evidence.parentSha);
    expect(git(task, 'rev-parse', 'HEAD')).toBe(evidence.commitSha);
  });

  it('refuses an already existing branch without any remote writes', async () => {
    const mock = githubMock({ alreadyExists: true });
    await expect(assertGitHubBranchAbsent(BRANCH, 'mock-token')).rejects.toThrow('already exists');
    await expect(
      publishExactCommit(
        evidence,
        'mock-token',
        async () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow('already exists');
    expect(mock.requests.every((x) => x.method === 'GET')).toBe(true);
  });

  it.each(['wrongBlob', 'wrongTree', 'wrongCommit'] as const)(
    'rejects a mismatching GitHub %s response BEFORE creating a ref',
    async (key) => {
      const mock = githubMock({ [key]: true });
      let refAttempted = false;
      await expect(
        publishExactCommit(
          evidence,
          'mock-token',
          async () => undefined,
          () => {
            refAttempted = true;
          },
        ),
      ).rejects.toThrow('SHA mismatch');
      expect(refAttempted).toBe(false);
      expect(mock.requests.some((x) => x.url.endsWith('/git/refs'))).toBe(false);
    },
  );

  it('rejects race in last-second local review without branch creation', async () => {
    const mock = githubMock();
    let attempted = false;
    await expect(
      publishExactCommit(
        evidence,
        'mock-token',
        async () => {
          throw Error('file SHA changed before ref');
        },
        () => {
          attempted = true;
        },
      ),
    ).rejects.toThrow('file SHA changed');
    expect(attempted).toBe(false);
    expect(mock.isCreated()).toBe(false);
  });

  it('never retries ambiguous remote ref creation and marks the attempt', async () => {
    const mock = githubMock({ failRefCreation: true });
    let attempted = false;
    await expect(
      publishExactCommit(
        evidence,
        'mock-token',
        async () => undefined,
        () => {
          attempted = true;
        },
      ),
    ).rejects.toThrow('GitHub publish');
    expect(attempted).toBe(true);
    expect(mock.requests.filter((x) => x.url.endsWith('/git/refs'))).toHaveLength(1);
  });

  it('fails closed if GitHub cannot confirm the new reference', async () => {
    const mock = githubMock({ lostRefConfirmation: true });
    await expect(
      publishExactCommit(
        evidence,
        'mock-token',
        async () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow('confirmed');
    expect(mock.requests.filter((x) => x.url.endsWith('/git/refs'))).toHaveLength(1);
  });

  it('rejects changed worktree or unauthorized tree before reading publish payload', async () => {
    await writeFile(join(task, 'surprise.txt'), 'unexpected\n');
    await expect(
      inspectLocalCommitForPush(plan, SESSION, PLAN_ID, evidence.commitSha),
    ).rejects.toThrow('Unexpected Git tree');
    const planOther = { ...plan, proposedBranch: 'main' };
    await expect(
      inspectLocalCommitForPush(planOther, SESSION, PLAN_ID, evidence.commitSha),
    ).rejects.toThrow('approved isolated');
  });
});
