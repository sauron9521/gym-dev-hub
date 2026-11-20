import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, lstat, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubService } from '../src/github/github.service.js';
import { WorkspaceService } from '../src/workspace/workspace.service.js';
import { CodexBridgeService } from '../src/codex/codex-bridge.service.js';
import { WorktreePlanService } from '../src/worktree/worktree-plan.service.js';
import { WorktreeGitService } from '../src/worktree/worktree-git.service.js';
import { WorktreeAuthorizationService } from '../src/worktree/worktree-authorization.service.js';

const TEST_SECRET = 'local-test-secret-abcdefghijklmnopqrstuvwxyz-0123456789';

describe('single-use metadata-only worktree creation', () => {
  let dir: string;
  let source: string;
  let workspace: WorkspaceService;
  let plans: WorktreePlanService;
  let git: WorktreeGitService;
  let authorization: WorktreeAuthorizationService;

  const gitCommand = (...args: string[]) =>
    execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gym-dev-hub-safe-create-'));
    source = join(dir, 'repos', 'gym-platform');
    await mkdir(source, { recursive: true });
    execFileSync('git', ['init', '--quiet', source]);
    gitCommand('config', 'user.name', 'Dev Hub Integration Test');
    gitCommand('config', 'user.email', 'devhub@example.invalid');
    gitCommand('remote', 'add', 'origin', 'https://github.com/sauron9521/gym-platform.git');
    await writeFile(join(source, 'proof.txt'), 'Test fixture only\n', 'utf8');
    gitCommand('add', 'proof.txt');
    gitCommand('commit', '-qm', 'init test fixture');
    const storeDir = join(dir, 'store');
    await mkdir(storeDir, { recursive: true });
    process.env.DEV_HUB_REPOS_ROOT = join(dir, 'repos');
    process.env.DEV_HUB_WORKTREES_ROOT = join(storeDir, 'worktrees');
    process.env.DEV_HUB_PLAN_FILE = join(storeDir, 'plans.json');
    process.env.DEV_HUB_WORKSPACE_FILE = join(storeDir, 'sessions.json');
    process.env.GITHUB_REPOSITORIES = 'sauron9521/gym-platform';
    process.env.DEV_HUB_ENABLE_WORKTREE_CREATION = 'true';
    process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET = TEST_SECRET;

    const github = new GitHubService();
    workspace = new WorkspaceService(github, new CodexBridgeService());
    plans = new WorktreePlanService(workspace, github);
    git = new WorktreeGitService();
    authorization = new WorktreeAuthorizationService(plans, git);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const name of [
      'DEV_HUB_REPOS_ROOT',
      'DEV_HUB_WORKTREES_ROOT',
      'DEV_HUB_PLAN_FILE',
      'DEV_HUB_WORKSPACE_FILE',
      'GITHUB_REPOSITORIES',
      'DEV_HUB_ENABLE_WORKTREE_CREATION',
      'DEV_HUB_WORKTREE_OPERATOR_SECRET',
    ])
      delete process.env[name];
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function approved() {
    const session = await workspace.create({
      title: 'Safe worktree test',
      repository: 'sauron9521/gym-platform',
      task: 'Test only, never touch user project',
    });
    const plan = await plans.create(session.id);
    const confirmed = await plans.acknowledge(session.id, plan.id, {
      fingerprint: plan.fingerprint,
      confirmation: 'I_APPROVE_THIS_PLAN_ONLY',
    });
    return { session, plan: confirmed };
  }

  const getGrant = async (
    auth: WorktreeAuthorizationService,
    sessionId: string,
    planId: string,
    fingerprint: string,
  ) => auth.authorize(sessionId, planId, { fingerprint, operatorSecret: TEST_SECRET });

  it('creates exactly one metadata-only Git worktree and preserves the source checkout', async () => {
    const { session, plan } = await approved();
    const originalSha = gitCommand('rev-parse', 'HEAD');
    const grant = await getGrant(authorization, session.id, plan.id, plan.fingerprint);
    expect(grant).toMatchObject({ baseHeadSha: originalSha, purpose: 'CREATE_METADATA_ONLY' });
    const results = await Promise.allSettled([
      authorization.create(session.id, plan.id, { grantToken: grant.grantToken }),
      authorization.create(session.id, plan.id, { grantToken: grant.grantToken }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const completed = results.find((result) => result.status === 'fulfilled')!;
    if (completed.status !== 'fulfilled') throw new Error('No success');
    expect(completed.value).toMatchObject({
      state: 'created',
      worktreeCreated: true,
      executionEnabled: false,
    });
    expect(completed.value.baseHeadSha).toBe(originalSha);
    const metadata = await lstat(join(plan.targetPath, '.git'));
    expect(metadata.isFile()).toBe(true);
    expect(await readdir(plan.targetPath)).toEqual(['.git']);
    expect(gitCommand('rev-parse', 'HEAD')).toBe(originalSha);
    expect(gitCommand('status', '--porcelain')).toBe('');
    expect(gitCommand('worktree', 'list', '--porcelain')).toContain(
      `branch refs/heads/${plan.proposedBranch}`,
    );
    expect((await plans.list(session.id))[0].history.map((entry) => entry.event)).toEqual([
      'created',
      'acknowledged',
      'creation-started',
      'worktree-created',
    ]);
    await expect(plans.revoke(session.id, plan.id, {})).rejects.toThrow('не можна відкликати');
  });

  it('requires explicit opt-in and a strong configured secret', async () => {
    const { session, plan } = await approved();
    process.env.DEV_HUB_ENABLE_WORKTREE_CREATION = 'false';
    await expect(getGrant(authorization, session.id, plan.id, plan.fingerprint)).rejects.toThrow(
      'вимкнено',
    );
    process.env.DEV_HUB_ENABLE_WORKTREE_CREATION = 'true';
    process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET = 'weak';
    await expect(getGrant(authorization, session.id, plan.id, plan.fingerprint)).rejects.toThrow(
      'випадковий секрет',
    );
    process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET = TEST_SECRET;
    await expect(
      authorization.authorize(session.id, plan.id, {
        fingerprint: plan.fingerprint,
        operatorSecret: 'wrong-secret-with-length-32-plus-123456789',
      }),
    ).rejects.toThrow('Невірний секрет');
    expect((await plans.list(session.id))[0].state).toBe('acknowledged');
  });

  it('rejects expired and cross-session grants without invoking Git', async () => {
    const { session, plan } = await approved();
    const grant = await getGrant(authorization, session.id, plan.id, plan.fingerprint);
    const other = await approved();
    await expect(
      authorization.create(other.session.id, other.plan.id, {
        grantToken: grant.grantToken,
      }),
    ).rejects.toThrow('Дозвіл недійсний');
    await expect(
      authorization.create(session.id, plan.id, {
        grantToken: grant.grantToken,
      }),
    ).rejects.toThrow('Дозвіл недійсний');
    expect(await readdir(join(dir, 'store', 'worktrees')).catch(() => [])).toEqual([]);
  });

  it('fails closed when Git HEAD changes between authorization and use', async () => {
    const { session, plan } = await approved();
    const grant = await getGrant(authorization, session.id, plan.id, plan.fingerprint);
    await writeFile(join(source, 'new.txt'), 'commit after grant\n');
    gitCommand('add', 'new.txt');
    gitCommand('commit', '-qm', 'different commit');
    await expect(
      authorization.create(session.id, plan.id, {
        grantToken: grant.grantToken,
      }),
    ).rejects.toThrow('Не вдалося створити');
    expect((await plans.list(session.id))[0]).toMatchObject({
      state: 'failed',
      worktreeCreated: false,
    });
    await expect(lstat(plan.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects target path collisions rather than deleting files', async () => {
    const { session, plan } = await approved();
    const grant = await getGrant(authorization, session.id, plan.id, plan.fingerprint);
    await mkdir(plan.targetPath, { recursive: true });
    await writeFile(join(plan.targetPath, 'keep.txt'), 'never delete user files');
    await expect(
      authorization.create(session.id, plan.id, {
        grantToken: grant.grantToken,
      }),
    ).rejects.toThrow('Не вдалося створити');
    expect((await plans.list(session.id))[0]).toMatchObject({
      state: 'failed',
      worktreeCreated: false,
    });
    expect(await readdir(plan.targetPath)).toEqual(['keep.txt']);
  });

  it('expires the one-time grant without touching Git or reserving the plan', async () => {
    const { session, plan } = await approved();
    const issued = await getGrant(authorization, session.id, plan.id, plan.fingerprint);
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
    await expect(
      authorization.create(session.id, plan.id, {
        grantToken: issued.grantToken,
      }),
    ).rejects.toThrow('Дозвіл недійсний');
    expect((await plans.list(session.id))[0].state).toBe('acknowledged');
    await expect(lstat(plan.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('immediately invalidates an issued grant when the feature is disabled', async () => {
    const { session, plan } = await approved();
    const issued = await getGrant(authorization, session.id, plan.id, plan.fingerprint);
    process.env.DEV_HUB_ENABLE_WORKTREE_CREATION = 'false';
    await expect(
      authorization.create(session.id, plan.id, {
        grantToken: issued.grantToken,
      }),
    ).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_WORKTREE_CREATION = 'true';
    await expect(
      authorization.create(session.id, plan.id, {
        grantToken: issued.grantToken,
      }),
    ).rejects.toThrow('Дозвіл недійсний');
    expect((await plans.list(session.id))[0].state).toBe('acknowledged');
  });

  it('does not allow new authorization when the plan is not acknowledged', async () => {
    const session = await workspace.create({
      title: 'Pending plan',
      repository: 'sauron9521/gym-platform',
      task: 'Pending',
    });
    const plan = await plans.create(session.id);
    await expect(getGrant(authorization, session.id, plan.id, plan.fingerprint)).rejects.toThrow(
      'погодь',
    );
  });
});
