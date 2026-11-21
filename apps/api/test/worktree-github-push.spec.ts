import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorktreeGitHubPushService } from '../src/worktree/worktree-github-push.service.js';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  absent: vi.fn(),
  publish: vi.fn(),
}));
vi.mock('../src/worktree/worktree-github-publisher.js', () => ({
  inspectLocalCommitForPush: mocks.inspect,
  assertGitHubBranchAbsent: mocks.absent,
  publishExactCommit: mocks.publish,
}));

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN_ID = '00000000-0000-4000-8000-000000000123';
const BRANCH = 'devhub/task-' + 'a'.repeat(32);
const COMMIT = 'b'.repeat(40);
const PARENT = 'c'.repeat(40);
const SECRET = 'github-publish-independent-secret-abcdefghijklmnopqrstuvwxyz';
const API_TOKEN = 'github_mock_test_token_for_publish_abcdefghijklmnopqrstuvwxyz';

describe('operator-only publish new GitHub task branch grant', () => {
  let root: string;
  let service: WorktreeGitHubPushService;
  let plans: { availableForMountProbe: ReturnType<typeof vi.fn> };
  const authorize = () => ({
    commitSha: COMMIT,
    operatorSecret: SECRET,
    confirmation: 'I_AUTHORIZE_NEW_TASK_BRANCH_ONLY',
  });
  const execute = (grant: { grantId: string; grantToken: string }) => ({
    grantId: grant.grantId,
    grantToken: grant.grantToken,
    runId: randomUUID(),
    operatorSecret: SECRET,
    confirmation: 'I_PUBLISH_THIS_EXACT_COMMIT_TO_NEW_TASK_BRANCH',
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(join(tmpdir(), 'github-push-grant-'));
    process.env.DEV_HUB_COMMIT_STATE_DIR = join(root, 'private');
    process.env.DEV_HUB_ENABLE_GITHUB_PUBLISH = 'true';
    process.env.DEV_HUB_GITHUB_PUBLISH_OPERATOR_SECRET = SECRET;
    process.env.DEV_HUB_GITHUB_PUBLISH_TOKEN = API_TOKEN;
    plans = {
      availableForMountProbe: vi.fn().mockResolvedValue({
        repository: 'sauron9521/gym-dev-hub',
        proposedBranch: BRANCH,
        baseHeadSha: PARENT,
        targetPath: join(root, 'task'),
      }),
    };
    mocks.inspect.mockImplementation(async () => ({
      branch: BRANCH,
      commitSha: COMMIT,
      parentSha: PARENT,
      treeSha: 'd'.repeat(40),
      blobSha: 'e'.repeat(40),
      rawContent: Buffer.from('reviewed'),
    }));
    mocks.absent.mockResolvedValue(undefined);
    mocks.publish.mockImplementation(async (_commit, _token, before, refAttempted) => {
      await before();
      refAttempted();
    });
    service = new WorktreeGitHubPushService(plans as never);
  });
  afterEach(async () => {
    for (const key of [
      'DEV_HUB_COMMIT_STATE_DIR',
      'DEV_HUB_ENABLE_GITHUB_PUBLISH',
      'DEV_HUB_GITHUB_PUBLISH_OPERATOR_SECRET',
      'DEV_HUB_GITHUB_PUBLISH_TOKEN',
    ])
      delete process.env[key];
    await rm(root, { recursive: true, force: true });
  });

  it('writes metadata audit, publishes once, never exposes a GitHub token', async () => {
    const grant = await service.authorize(SESSION, PLAN_ID, authorize());
    expect(grant).toMatchObject({
      branch: BRANCH,
      commitSha: COMMIT,
      parentSha: PARENT,
      purpose: 'CREATE_NEW_GITHUB_TASK_BRANCH_ONLY',
      forcePushEnabled: false,
      mainWriteEnabled: false,
      pullRequestEnabled: false,
      mergeEnabled: false,
    });
    expect(grant.grantToken).toHaveLength(43);
    expect(JSON.stringify(grant)).not.toContain(API_TOKEN);
    const request = execute(grant);
    const receipt = await service.execute(SESSION, PLAN_ID, request);
    expect(receipt).toMatchObject({
      runId: request.runId,
      grantId: grant.grantId,
      commitSha: COMMIT,
      parentSha: PARENT,
      branch: BRANCH,
      status: 'published',
      forcePushEnabled: false,
      mainWriteEnabled: false,
      pullRequestCreated: false,
      mergeEnabled: false,
    });
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledTimes(3);
    await expect(service.execute(SESSION, PLAN_ID, request)).rejects.toThrow(
      'повторно використаний',
    );
    const audit = await readFile(join(root, 'private', 'github-push.jsonl'), 'utf8');
    expect([...audit.matchAll(/"event":"([a-z-]+)"/g)].map((x) => x[1])).toEqual([
      'issued',
      'attempted',
      'published',
    ]);
    expect(audit).not.toContain(API_TOKEN);
    expect(audit).not.toContain(SECRET);
    expect(audit).not.toContain(grant.grantToken);
    await expect(lstat(join(root, 'private', PLAN_ID + '.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('is OFF by default, requires independent operator secret and separate Contents:write token', async () => {
    delete process.env.DEV_HUB_ENABLE_GITHUB_PUBLISH;
    await expect(service.authorize(SESSION, PLAN_ID, authorize())).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_GITHUB_PUBLISH = 'true';
    await expect(
      service.authorize(SESSION, PLAN_ID, {
        ...authorize(),
        operatorSecret: 'x'.repeat(48),
      }),
    ).rejects.toThrow('секрет');
    delete process.env.DEV_HUB_GITHUB_PUBLISH_TOKEN;
    await expect(service.authorize(SESSION, PLAN_ID, authorize())).rejects.toThrow(
      'Contents:write',
    );
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('refuses arbitrary repository, target branch, force or push arguments', async () => {
    for (const payload of [
      { force: true },
      { remote: 'https://untrusted.invalid' },
      { branch: 'main' },
      { ref: 'refs/heads/main' },
      { command: 'git push --force' },
      { confirmation: 'I_ALLOW_FORCE_PUSH' },
    ])
      await expect(
        service.authorize(SESSION, PLAN_ID, {
          ...authorize(),
          ...payload,
        }),
      ).rejects.toThrow('Некоректний');
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('never issues a grant when remote branch exists or local Git audit is invalid', async () => {
    mocks.absent.mockRejectedValueOnce(new Error('Remote task branch already exists'));
    await expect(service.authorize(SESSION, PLAN_ID, authorize())).rejects.toThrow(
      'already exists',
    );
    mocks.inspect.mockRejectedValueOnce(new Error('Missing local commit audit'));
    await expect(service.authorize(SESSION, PLAN_ID, authorize())).rejects.toThrow(
      'Missing local commit audit',
    );
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('burns grant on wrong session or grant ID, without remote publishing', async () => {
    const grant = await service.authorize(SESSION, PLAN_ID, authorize());
    await expect(service.execute(randomUUID(), PLAN_ID, execute(grant))).rejects.toThrow(
      'недійсний',
    );
    await expect(service.execute(SESSION, PLAN_ID, execute(grant))).rejects.toThrow(
      'повторно використаний',
    );
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('rejects last-second Git drift, logs rejection and releases lock before a remote ref attempt', async () => {
    const grant = await service.authorize(SESSION, PLAN_ID, authorize());
    mocks.inspect.mockResolvedValueOnce({
      branch: BRANCH,
      commitSha: COMMIT,
      parentSha: PARENT,
      treeSha: '0'.repeat(40),
      blobSha: 'e'.repeat(40),
      rawContent: Buffer.from('reviewed'),
    });
    const req = execute(grant);
    await expect(service.execute(SESSION, PLAN_ID, req)).rejects.toThrow('змінилися');
    expect(mocks.publish).not.toHaveBeenCalled();
    const audit = await readFile(join(root, 'private', 'github-push.jsonl'), 'utf8');
    expect(audit).toContain('"event":"rejected"');
    await expect(lstat(join(root, 'private', PLAN_ID + '.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves lock and suppresses retry after ambiguous remote ref creation', async () => {
    mocks.publish.mockImplementationOnce(async (_commit, _token, before, refAttempted) => {
      await before();
      refAttempted();
      throw new Error('lost ref creation response');
    });
    const grant = await service.authorize(SESSION, PLAN_ID, authorize());
    await expect(service.execute(SESSION, PLAN_ID, execute(grant))).rejects.toThrow(
      'могла бути створена',
    );
    const lock = await lstat(join(root, 'private', PLAN_ID + '.lock'));
    expect(lock.isFile()).toBe(true);
    const audit = await readFile(join(root, 'private', 'github-push.jsonl'), 'utf8');
    expect(audit).toContain('"event":"rejected"');
    expect(audit).not.toContain('"event":"published"');
  });

  it('prevents a second authorization while the remote publish is running', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.publish.mockImplementationOnce(async (_commit, _token, before, refAttempted) => {
      await before();
      await pending;
      refAttempted();
    });
    const grant = await service.authorize(SESSION, PLAN_ID, authorize());
    const run = service.execute(SESSION, PLAN_ID, execute(grant));
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce());
    await expect(service.authorize(SESSION, PLAN_ID, authorize())).rejects.toThrow('вже триває');
    release();
    await expect(run).resolves.toMatchObject({ status: 'published' });
  });
});
