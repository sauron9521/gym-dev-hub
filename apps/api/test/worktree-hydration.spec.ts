import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubService } from '../src/github/github.service.js';
import { WorkspaceService } from '../src/workspace/workspace.service.js';
import { CodexBridgeService } from '../src/codex/codex-bridge.service.js';
import { WorktreePlanService } from '../src/worktree/worktree-plan.service.js';
import { WorktreeGitService } from '../src/worktree/worktree-git.service.js';
import { WorktreeInspectionService } from '../src/worktree/worktree-inspection.service.js';
import { WorktreeAuthorizationService } from '../src/worktree/worktree-authorization.service.js';
import { WorktreeHydrationService } from '../src/worktree/worktree-hydration.service.js';
import { WorktreeIntegrityService } from '../src/worktree/worktree-integrity.service.js';
import type { WorktreePlan } from '@gym-dev-hub/contracts';

const TEST_SECRET = 'fixture-operator-secret-0123456789-abcdefghijklmnopqrstuvwxyz';

describe('bounded, one-time raw Git blob hydration on real Git fixtures', () => {
  let dir: string;
  let source: string;
  let plan: WorktreePlan;
  let sessionId: string;
  let plans: WorktreePlanService;
  let hydration: WorktreeHydrationService;
  let inspection: WorktreeInspectionService;

  function git(...args: string[]): string {
    return execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devhub-raw-blobs-'));
    source = join(dir, 'repos', 'gym-platform');
    await mkdir(join(source, 'src'), { recursive: true });
    execFileSync('git', ['init', '--quiet', source]);
    git('config', 'user.name', 'Hydration Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('remote', 'add', 'origin', 'https://github.com/sauron9521/gym-platform.git');
    await writeFile(join(source, 'src', 'hello.txt'), 'Text from committed Git blob\n');
    await writeFile(join(source, 'binary.dat'), Buffer.from([0, 1, 2, 255, 10, 0]));
    await writeFile(join(source, '.gitattributes'), '*.txt filter=untrusted\n');
    git('config', 'filter.untrusted.smudge', 'echo THIS_MUST_NEVER_RUN');
    git('add', '.');
    git('commit', '-qm', 'tracked fixture files');
    process.env.DEV_HUB_REPOS_ROOT = join(dir, 'repos');
    process.env.DEV_HUB_WORKTREES_ROOT = join(dir, 'worktrees');
    process.env.DEV_HUB_WORKSPACE_FILE = join(dir, 'session-store.json');
    process.env.DEV_HUB_PLAN_FILE = join(dir, 'plan-store.json');
    process.env.GITHUB_REPOSITORIES = 'sauron9521/gym-platform';
    process.env.DEV_HUB_ENABLE_WORKTREE_CREATION = 'true';
    process.env.DEV_HUB_ENABLE_WORKTREE_HYDRATION = 'true';
    process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET = TEST_SECRET;

    const github = new GitHubService();
    const workspace = new WorkspaceService(github, new CodexBridgeService());
    plans = new WorktreePlanService(workspace, github);
    inspection = new WorktreeInspectionService();
    hydration = new WorktreeHydrationService(plans, inspection);
    const gitService = new WorktreeGitService();
    const creation = new WorktreeAuthorizationService(plans, gitService);
    const session = await workspace.create({
      title: 'Safe hydration fixture',
      task: 'Write raw Git blobs only',
      repository: 'sauron9521/gym-platform',
    });
    sessionId = session.id;
    const planned = await plans.create(sessionId);
    await plans.acknowledge(sessionId, planned.id, {
      fingerprint: planned.fingerprint,
      confirmation: 'I_APPROVE_THIS_PLAN_ONLY',
    });
    const grant = await creation.authorize(sessionId, planned.id, {
      fingerprint: planned.fingerprint,
      operatorSecret: TEST_SECRET,
    });
    plan = await creation.create(sessionId, planned.id, { grantToken: grant.grantToken });
    expect(plan.state).toBe('created');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const name of [
      'DEV_HUB_REPOS_ROOT',
      'DEV_HUB_WORKTREES_ROOT',
      'DEV_HUB_WORKSPACE_FILE',
      'DEV_HUB_PLAN_FILE',
      'GITHUB_REPOSITORIES',
      'DEV_HUB_ENABLE_WORKTREE_CREATION',
      'DEV_HUB_ENABLE_WORKTREE_HYDRATION',
      'DEV_HUB_WORKTREE_OPERATOR_SECRET',
    ])
      delete process.env[name];
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function issueGrant() {
    return hydration.authorize(sessionId, plan.id, {
      fingerprint: plan.fingerprint,
      operatorSecret: TEST_SECRET,
    });
  }

  it('copies bytes from Git without invoking smudge filters, hooks or checkout', async () => {
    const grant = await issueGrant();
    expect(grant.purpose).toBe('WRITE_RAW_GIT_BLOBS_ONLY');
    expect(grant.baseHeadSha).toBe(git('rev-parse', 'HEAD'));
    const result = await hydration.hydrate(sessionId, plan.id, { grantToken: grant.grantToken });
    expect(result).toMatchObject({
      state: 'created',
      hydrationState: 'completed',
      hydrationFiles: 3,
      executionEnabled: false,
    });
    expect(await readFile(join(plan.targetPath, 'binary.dat'))).toEqual(
      Buffer.from([0, 1, 2, 255, 10, 0]),
    );
    expect(await readFile(join(plan.targetPath, 'src', 'hello.txt'), 'utf8')).toBe(
      'Text from committed Git blob\n',
    );
    expect(await readFile(join(plan.targetPath, '.gitattributes'), 'utf8')).toBe(
      '*.txt filter=untrusted\n',
    );
    expect(git('status', '--porcelain')).toBe('');
    expect((await plans.list(sessionId))[0].history.map((e) => e.event).slice(-2)).toEqual([
      'hydration-started',
      'hydration-completed',
    ]);
    const recheck = await inspection.inspect(result);
    expect(recheck.state).toBe('needs-review'); // No false "empty" preflight after materialization.
  });

  it('reconstructs the per-worktree index for one-file Git review after hydration', async () => {
    const worktreeGit = (...args: string[]): string =>
      execFileSync('git', ['-C', plan.targetPath, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    expect(worktreeGit('ls-files')).toBe(''); // The metadata-only worktree has no index.

    const grant = await issueGrant();
    await hydration.hydrate(sessionId, plan.id, { grantToken: grant.grantToken });

    expect(worktreeGit('ls-files')).toBe('.gitattributes\nbinary.dat\nsrc/hello.txt');
    expect(worktreeGit('diff', '--cached', '--name-only', 'HEAD')).toBe('');
    expect(worktreeGit('diff', '--name-only', 'HEAD')).toBe('');

    await writeFile(join(plan.targetPath, 'src', 'hello.txt'), 'Approved one-file edit\n');
    expect(worktreeGit('diff', '--name-only', 'HEAD')).toBe('src/hello.txt');
  });

  it('consumes an authorization exactly once even with concurrent requests', async () => {
    const grant = await issueGrant();
    const results = await Promise.allSettled([
      hydration.hydrate(sessionId, plan.id, { grantToken: grant.grantToken }),
      hydration.hydrate(sessionId, plan.id, { grantToken: grant.grantToken }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(
      hydration.hydrate(sessionId, plan.id, { grantToken: grant.grantToken }),
    ).rejects.toThrow('Дозвіл прострочений');
  });

  it('is disabled by default and requires a distinct opt-in', async () => {
    process.env.DEV_HUB_ENABLE_WORKTREE_HYDRATION = 'false';
    await expect(issueGrant()).rejects.toThrow('Hydration вимкнено');
    process.env.DEV_HUB_ENABLE_WORKTREE_HYDRATION = 'true';
    const grant = await issueGrant();
    process.env.DEV_HUB_ENABLE_WORKTREE_HYDRATION = 'false';
    await expect(
      hydration.hydrate(sessionId, plan.id, { grantToken: grant.grantToken }),
    ).rejects.toThrow('Hydration вимкнено');
    process.env.DEV_HUB_ENABLE_WORKTREE_HYDRATION = 'true';
    await expect(
      hydration.hydrate(sessionId, plan.id, { grantToken: grant.grantToken }),
    ).rejects.toThrow('Дозвіл прострочений');
  });

  it('rejects wrong operator secret without altering the worktree', async () => {
    await expect(
      hydration.authorize(sessionId, plan.id, {
        fingerprint: plan.fingerprint,
        operatorSecret: 'invalid-operator-secret-with-32-chars-1234',
      }),
    ).rejects.toThrow('Невірний секрет');
    expect(await readdir(plan.targetPath)).toEqual(['.git']);
  });

  it('refuses hydration after an unexpected file appears', async () => {
    const grant = await issueGrant();
    await writeFile(join(plan.targetPath, 'manual-file.txt'), 'do not overwrite');
    await expect(
      hydration.hydrate(sessionId, plan.id, { grantToken: grant.grantToken }),
    ).rejects.toThrow('Worktree змінився');
    expect(await readFile(join(plan.targetPath, 'manual-file.txt'), 'utf8')).toBe(
      'do not overwrite',
    );
    expect((await plans.list(sessionId))[0].hydrationState).toBeUndefined();
  });

  it('rejects expired grant before any filesystem mutations', async () => {
    const grant = await issueGrant();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await expect(
      hydration.hydrate(sessionId, plan.id, { grantToken: grant.grantToken }),
    ).rejects.toThrow('Дозвіл прострочений');
    expect(await readdir(plan.targetPath)).toEqual(['.git']);
  });

  it('leaves partial files with a failed state and forbids auto-retry', async () => {
    // Force failure before any write by making Git tree unsupported after reservation.
    // Unlike rollback, this must never delete the manually created worktree.
    const grant = await issueGrant();
    const spy = vi.spyOn(plans, 'finishHydration');
    spy.mockImplementationOnce(async (_session, _plan, outcome) => {
      if (outcome === 'completed') throw new Error('simulated storage failure');
      throw new Error('unexpected outcome');
    });
    await expect(
      hydration.hydrate(sessionId, plan.id, { grantToken: grant.grantToken }),
    ).rejects.toThrow('Hydration перервано');
    const stored = (await plans.list(sessionId))[0];
    expect(stored.hydrationState).toBe('failed');
    expect(await lstat(join(plan.targetPath, 'binary.dat'))).toBeDefined();
    await expect(issueGrant()).rejects.toThrow('Worktree уже наповнений');
    expect((await readdir(plan.targetPath)).length).toBeGreaterThan(1);
  });
  async function completedHydration() {
    const grant = await issueGrant();
    return hydration.hydrate(sessionId, plan.id, { grantToken: grant.grantToken });
  }

  it('verifies post-hydration Git hashes and returns an inert mount preflight', async () => {
    const completed = await completedHydration();
    const integrity = new WorktreeIntegrityService(plans, inspection);
    const report = await integrity.verify(sessionId, completed.id);
    expect(report).toMatchObject({
      status: 'verified',
      fileCount: 3,
      mount: {
        sourcePath: plan.targetPath,
        targetPath: '/workspace',
        readOnly: true,
        networkEnabled: false,
        mountEnabled: false,
        executionEnabled: false,
      },
    });
    expect(report.verifiedBytes).toBeGreaterThan(0);
    expect(report.findings).toEqual([]);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('refuses mount-readiness before hydration completes', async () => {
    const integrity = new WorktreeIntegrityService(plans, inspection);
    const report = await integrity.verify(sessionId, plan.id);
    expect(report.status).toBe('not-ready');
    expect(report.mount.mountEnabled).toBe(false);
    expect(report.findings.join(' ')).toContain('успішно завершене');
  });

  it('detects byte-level tampering and never overwrites a modified file', async () => {
    await completedHydration();
    const changed = join(plan.targetPath, 'src', 'hello.txt');
    await writeFile(changed, 'Modified! blob content\n', 'utf8');
    const integrity = new WorktreeIntegrityService(plans, inspection);
    const report = await integrity.verify(sessionId, plan.id);
    expect(report.status).toBe('mismatch');
    expect(report.mount.mountEnabled).toBe(false);
    expect(await readFile(changed, 'utf8')).toBe('Modified! blob content\n');
  });

  it('detects added files and extra directories without deleting data', async () => {
    await completedHydration();
    await mkdir(join(plan.targetPath, 'untracked'));
    await writeFile(join(plan.targetPath, 'untracked', 'keep.txt'), 'do not delete');
    const integrity = new WorktreeIntegrityService(plans, inspection);
    const report = await integrity.verify(sessionId, plan.id);
    expect(report.status).toBe('mismatch');
    expect(await readFile(join(plan.targetPath, 'untracked', 'keep.txt'), 'utf8')).toBe(
      'do not delete',
    );
  });

  it('detects missing files and incorrect hydration progress metadata', async () => {
    await completedHydration();
    const integrity = new WorktreeIntegrityService(plans, inspection);
    const missing = join(plan.targetPath, 'binary.dat');
    await rm(missing);
    expect((await integrity.verify(sessionId, plan.id)).status).toBe('mismatch');
  });

  it('never exposes another session plan through the integrity endpoint', async () => {
    await completedHydration();
    const integrity = new WorktreeIntegrityService(plans, inspection);
    await expect(
      integrity.verify('00000000-0000-4000-8000-000000000999', plan.id),
    ).rejects.toThrow();
  });
});
