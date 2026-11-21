import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeCommitWriteService } from '../src/worktree/worktree-commit-write.service.js';

const mocks = vi.hoisted(() => ({ commit: vi.fn() }));
vi.mock('../src/worktree/worktree-fixed-commit.js', async (original) => {
  const value = await original<typeof import('../src/worktree/worktree-fixed-commit.js')>();
  return {
    ...value,
    fixedOneFileCommit: mocks.commit,
  };
});

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const CANDIDATE = '00000000-0000-4000-8000-000000000987';
const HASH = 'd'.repeat(64);
const COMMIT = 'a'.repeat(40);
const BRANCH = 'devhub/task-' + 'c'.repeat(32);
const SECRET = 'fixed-local-commit-secret-abcdefghijklmnopqrstuvwxyz';
const REVIEW_SECRET = 'review-secret-abcdefghijklmnopqrstuvwxyz-123';
const CANDIDATE_SECRET = 'candidate-secret-abcdefghijklmnopqrstuvwxyz';

describe('separate one-shot local Git commit authorization', () => {
  let root: string;
  let service: WorktreeCommitWriteService;
  let candidates: {
    takeReviewedForCommit: ReturnType<typeof vi.fn>;
    assertEvidenceCurrent: ReturnType<typeof vi.fn>;
  };
  let plans: { availableForMountProbe: ReturnType<typeof vi.fn> };
  const auth = () => ({
    candidateId: CANDIDATE,
    candidateSha256: HASH,
    reviewOperatorSecret: REVIEW_SECRET,
    candidateOperatorSecret: CANDIDATE_SECRET,
    commitOperatorSecret: SECRET,
    confirmation: 'I_AUTHORIZE_ONE_LOCAL_GIT_COMMIT_GRANT',
  });
  const execute = (token: string, grantId: string) => ({
    grantToken: token,
    grantId,
    runId: randomUUID(),
    reviewOperatorSecret: REVIEW_SECRET,
    candidateOperatorSecret: CANDIDATE_SECRET,
    commitOperatorSecret: SECRET,
    confirmation: 'I_EXECUTE_THIS_ONE_LOCAL_GIT_COMMIT_ONLY',
  });
  const evidence = () => ({
    candidateSha256: HASH,
    expiresAt: Date.now() + 60_000,
    request: {
      grantId: '00000000-0000-4000-8000-000000000777',
      fingerprint: 'sha256:' + 'b'.repeat(64),
      sourceCommit: COMMIT,
      filePath: 'apps/api/src/main.ts',
      sourceSha256: 'e'.repeat(64),
      proposedSha256: 'f'.repeat(64),
      commitSubject: 'fix(api): make reviewed local commit',
    },
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(join(tmpdir(), 'hub-commit-write-'));
    process.env.DEV_HUB_ENABLE_GIT_COMMIT = 'true';
    process.env.DEV_HUB_GIT_COMMIT_OPERATOR_SECRET = SECRET;
    process.env.DEV_HUB_COMMIT_AUTHOR_NAME = 'Local Test Operator';
    process.env.DEV_HUB_COMMIT_AUTHOR_EMAIL = 'local@example.invalid';
    process.env.DEV_HUB_COMMIT_STATE_DIR = join(root, 'private');
    plans = {
      availableForMountProbe: vi.fn().mockResolvedValue({
        repository: 'sauron9521/gym-dev-hub',
        proposedBranch: BRANCH,
        targetPath: join(root, 'synthetic-worktree'),
        baseHeadSha: COMMIT,
      }),
    };
    candidates = {
      takeReviewedForCommit: vi.fn().mockImplementation(async () => evidence()),
      assertEvidenceCurrent: vi.fn().mockResolvedValue(undefined),
    };
    mocks.commit.mockImplementation(async (input, recheck, advanced) => {
      await recheck();
      advanced();
      return {
        commitSha: '1'.repeat(40),
        parentSha: COMMIT,
        treeSha: '2'.repeat(40),
        branch: BRANCH,
        blobSha: '3'.repeat(40),
        filePathSha256: '4'.repeat(64),
        refUpdated: true,
        worktreeClean: true,
      };
    });
    service = new WorktreeCommitWriteService(plans as never, candidates as never);
  });
  afterEach(async () => {
    for (const key of [
      'DEV_HUB_ENABLE_GIT_COMMIT',
      'DEV_HUB_GIT_COMMIT_OPERATOR_SECRET',
      'DEV_HUB_COMMIT_AUTHOR_NAME',
      'DEV_HUB_COMMIT_AUTHOR_EMAIL',
      'DEV_HUB_COMMIT_STATE_DIR',
    ])
      delete process.env[key];
    await rm(root, { recursive: true, force: true });
  });

  it('issues separate grant, burns it and commits with replay-proof audit and no push/merge', async () => {
    const grant = await service.authorize(SESSION, PLAN, auth());
    expect(grant).toMatchObject({
      candidateId: CANDIDATE,
      candidateSha256: HASH,
      sourceCommit: COMMIT,
      purpose: 'ONE_LOCAL_GIT_COMMIT_ONLY',
      pushEnabled: false,
      mergeEnabled: false,
    });
    expect(grant.grantToken).toHaveLength(43);
    const req = execute(grant.grantToken, grant.grantId);
    const result = await service.execute(SESSION, PLAN, req);
    expect(result).toMatchObject({
      runId: req.runId,
      grantId: grant.grantId,
      commitSha: '1'.repeat(40),
      parentSha: COMMIT,
      branch: BRANCH,
      worktreeClean: true,
      status: 'committed',
      pushEnabled: false,
      mergeEnabled: false,
    });
    expect(candidates.assertEvidenceCurrent).toHaveBeenCalledTimes(2);
    expect(mocks.commit).toHaveBeenCalledOnce();
    await expect(service.execute(SESSION, PLAN, req)).rejects.toThrow('вже використаний');
    await expect(lstat(join(root, 'private', PLAN + '.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const log = await readFile(join(root, 'private', 'audit.jsonl'), 'utf8');
    expect([...log.matchAll(/"event":"([a-z-]+)"/g)].map((m) => m[1])).toEqual([
      'issued',
      'attempted',
      'committed',
    ]);
    expect(log).toContain('"commitSha":"' + '1'.repeat(40));
    for (const secret of [SECRET, REVIEW_SECRET, CANDIDATE_SECRET, grant.grantToken]) {
      expect(log).not.toContain(secret);
    }
    expect(log).not.toContain(evidence().request.filePath);
    expect(log).not.toContain(evidence().request.commitSubject);
  });

  it('is disabled by default and requires a separate secret and explicit author identity', async () => {
    delete process.env.DEV_HUB_ENABLE_GIT_COMMIT;
    await expect(service.authorize(SESSION, PLAN, auth())).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_GIT_COMMIT = 'true';
    await expect(
      service.authorize(SESSION, PLAN, {
        ...auth(),
        commitOperatorSecret: 'x'.repeat(40),
      }),
    ).rejects.toThrow('секрет');
    delete process.env.DEV_HUB_COMMIT_AUTHOR_NAME;
    await expect(service.authorize(SESSION, PLAN, auth())).rejects.toThrow('explicit');
    expect(candidates.takeReviewedForCommit).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('strictly requires exact confirmation and refuses arbitrary commands and extra args', async () => {
    for (const bad of [
      { confirmation: 'I_ALLOW_GIT_PUSH' },
      { argv: ['git', 'push', 'origin', 'main'] },
      { shell: true },
    ])
      await expect(service.authorize(SESSION, PLAN, { ...auth(), ...bad })).rejects.toThrow(
        'Некоректний',
      );
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('refuses a non-scoped repository or unexpected ref name', async () => {
    plans.availableForMountProbe.mockResolvedValueOnce({
      repository: 'sauron9521/gym-platform',
      proposedBranch: BRANCH,
      baseHeadSha: COMMIT,
    });
    await expect(service.authorize(SESSION, PLAN, auth())).rejects.toThrow('task-гілці');
    plans.availableForMountProbe.mockResolvedValueOnce({
      repository: 'sauron9521/gym-dev-hub',
      proposedBranch: 'main',
      baseHeadSha: COMMIT,
    });
    await expect(service.authorize(SESSION, PLAN, auth())).rejects.toThrow('task-гілці');
  });

  it('burns grant before Git if the plan/session/grant changes', async () => {
    const grant = await service.authorize(SESSION, PLAN, auth());
    await expect(
      service.execute(SESSION, PLAN, {
        ...execute(grant.grantToken, grant.grantId),
        grantId: randomUUID(),
      }),
    ).rejects.toThrow('недійсний');
    await expect(
      service.execute(SESSION, PLAN, execute(grant.grantToken, grant.grantId)),
    ).rejects.toThrow('вже використаний');
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('rejects stale approved Git or failed evidence without invoking Git', async () => {
    const grant = await service.authorize(SESSION, PLAN, auth());
    candidates.assertEvidenceCurrent.mockRejectedValueOnce(new Error('Unexpected changed file'));
    await expect(
      service.execute(SESSION, PLAN, execute(grant.grantToken, grant.grantId)),
    ).rejects.toThrow('відхилено');
    expect(mocks.commit).not.toHaveBeenCalled();
    const audit = await readFile(join(root, 'private', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"event":"rejected"');
    await expect(lstat(join(root, 'private', PLAN + '.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('leaves a durable lock for manual recovery after uncertain post-CAS failure', async () => {
    mocks.commit.mockImplementationOnce(async (_input, before, advanced) => {
      await before();
      advanced();
      throw new Error('Index sync failed after ref CAS');
    });
    const grant = await service.authorize(SESSION, PLAN, auth());
    await expect(
      service.execute(SESSION, PLAN, execute(grant.grantToken, grant.grantId)),
    ).rejects.toThrow('ref міг змінитися');
    const stat = await lstat(join(root, 'private', PLAN + '.lock'));
    expect(stat.isFile()).toBe(true);
    const log = await readFile(join(root, 'private', 'audit.jsonl'), 'utf8');
    expect(log).toContain('"event":"attempted"');
    expect(log).toContain('"event":"rejected"');
    expect(log).not.toContain('"event":"committed"');
  });

  it('fails closed on symlinked audit file and never issues a bearer grant', async () => {
    const dir = join(root, 'private');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'outside'), 'do not touch');
    await symlink(join(root, 'outside'), join(dir, 'audit.jsonl'));
    await expect(service.authorize(SESSION, PLAN, auth())).rejects.toThrow('Журнал Git');
  });

  it('prevents a second commit while the first is active', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.commit.mockImplementationOnce(async (input, before, advanced) => {
      await before();
      await blocked;
      advanced();
      return {
        commitSha: '1'.repeat(40),
        parentSha: COMMIT,
        treeSha: '2'.repeat(40),
        branch: input.branch,
        blobSha: '3'.repeat(40),
        filePathSha256: '4'.repeat(64),
        refUpdated: true,
        worktreeClean: true,
      };
    });
    const grant = await service.authorize(SESSION, PLAN, auth());
    const request = execute(grant.grantToken, grant.grantId);
    const promise = service.execute(SESSION, PLAN, request);
    await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledOnce());
    await expect(service.authorize(SESSION, PLAN, auth())).rejects.toThrow('виконується');
    release();
    await expect(promise).resolves.toMatchObject({ status: 'committed' });
  });
});
