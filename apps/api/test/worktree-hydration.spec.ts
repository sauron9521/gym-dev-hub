import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubService } from '../src/github/github.service.js';
import { WorkspaceService } from '../src/workspace/workspace.service.js';
import { CodexBridgeService } from '../src/codex/codex-bridge.service.js';
import { WorktreePlanService } from '../src/worktree/worktree-plan.service.js';
import { WorktreeGitService } from '../src/worktree/worktree-git.service.js';
import { WorktreeAuthorizationService } from '../src/worktree/worktree-authorization.service.js';
import {
  parseSafeTree,
  WorktreeHydrationService,
} from '../src/worktree/worktree-hydration.service.js';

const SECRET = 'integration-test-operator-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
const OID = 'a'.repeat(40);
const line = (mode: string, name: string, size = 3) =>
  `${mode} blob ${OID}      ${size}\t${name}\0`;

describe('Git tree hydration parser', () => {
  it('accepts only ordinary bounded Git blobs with a stable fingerprint', () => {
    const data = Buffer.from(line('100644', 'src/index.ts', 12) + line('100755', 'scripts/test.sh', 7));
    const result = parseSafeTree(data);
    expect(result.files).toHaveLength(2);
    expect(result.bytes).toBe(19);
    expect(result.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ['symlink', '120000', 'link'],
    ['gitlink', '160000', 'vendor'],
    ['traversal', '100644', '../outside'],
    ['git-metadata', '100644', '.git/config'],
    ['windows-device', '100644', 'NUL.txt'],
    ['colon-ADS', '100644', 'file:stream'],
    ['backslash', '100644', 'dir\\file'],
    ['trailing-period', '100644', 'folder./item'],
  ])('rejects %s before writing any data', (_, mode, name) => {
    expect(() => parseSafeTree(Buffer.from(line(mode, name)))).toThrow();
  });

  it('rejects case insensitive duplicates and file/directory collisions', () => {
    expect(() => parseSafeTree(Buffer.from(line('100644', 'README.md') + line('100644', 'readme.MD'))))
      .toThrow();
    expect(() => parseSafeTree(Buffer.from(line('100644', 'src/foo') + line('100644', 'src'))))
      .toThrow();
  });

  it('rejects oversized blobs, missing NUL terminators and malformed entries', () => {
    expect(() => parseSafeTree(Buffer.from(line('100644', 'big.txt', 2 * 1024 * 1024 + 1))))
      .toThrow();
    expect(() => parseSafeTree(Buffer.from(line('100644', 'foo').slice(0, -1))))
      .toThrow();
    expect(() => parseSafeTree(Buffer.from('not git format\0'))).toThrow();
  });
});

describe('one-time safe worktree hydration', () => {
  let root: string;
  let source: string;
  let workspace: WorkspaceService;
  let plans: WorktreePlanService;
  let creation: WorktreeAuthorizationService;
  let hydration: WorktreeHydrationService;

  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'devhub-hydration-'));
    source = join(root, 'repos', 'gym-platform');
    await mkdir(join(source, 'src'), { recursive: true });
    execFileSync('git', ['init', '--quiet', source]);
    git('config', 'user.name', 'Dev Hub Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('remote', 'add', 'origin', 'https://github.com/sauron9521/gym-platform.git');
    await writeFile(join(source, 'src', 'index.ts'), 'export const number = 7;\n', 'utf8');
    await writeFile(join(source, 'README.md'), '# fixture\n', 'utf8');
    git('add', '.');
    git('commit', '-qm', 'initial fixture');

    const store = join(root, 'store');
    await mkdir(store, { recursive: true });
    process.env.DEV_HUB_REPOS_ROOT = join(root, 'repos');
    process.env.DEV_HUB_WORKTREES_ROOT = join(store, 'worktrees');
    process.env.DEV_HUB_PLAN_FILE = join(store, 'plans.json');
    process.env.DEV_HUB_WORKSPACE_FILE = join(store, 'sessions.json');
    process.env.GITHUB_REPOSITORIES = 'sauron9521/gym-platform';
    process.env.DEV_HUB_ENABLE_WORKTREE_CREATION = 'true';
    process.env.DEV_HUB_ENABLE_WORKTREE_HYDRATION = 'true';
    process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET = SECRET;

    const github = new GitHubService();
    workspace = new WorkspaceService(github, new CodexBridgeService());
    plans = new WorktreePlanService(workspace, github);
    const gitService = new WorktreeGitService();
    creation = new WorktreeAuthorizationService(plans, gitService);
    hydration = new WorktreeHydrationService(plans);
  });

  afterEach(async () => {
    for (const name of [
      'DEV_HUB_REPOS_ROOT', 'DEV_HUB_WORKTREES_ROOT',
      'DEV_HUB_PLAN_FILE', 'DEV_HUB_WORKSPACE_FILE',
      'GITHUB_REPOSITORIES', 'DEV_HUB_ENABLE_WORKTREE_CREATION',
      'DEV_HUB_ENABLE_WORKTREE_HYDRATION', 'DEV_HUB_WORKTREE_OPERATOR_SECRET',
    ]) delete process.env[name];
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function createdPlan() {
    const session = await workspace.create({
      title: 'Safe hydrate fixture',
      task: 'One temporary fixture only',
      repository: 'sauron9521/gym-platform',
    });
    const plan = await plans.create(session.id);
    await plans.acknowledge(session.id, plan.id, {
      fingerprint: plan.fingerprint, confirmation: 'I_APPROVE_THIS_PLAN_ONLY',
    });
    const creationGrant = await creation.authorize(session.id, plan.id, {
      fingerprint: plan.fingerprint, operatorSecret: SECRET,
    });
    const created = await creation.create(session.id, plan.id, {
      grantToken: creationGrant.grantToken,
    });
    return { session, plan: created };
  }

  it('hydrates committed blobs only and never touches the source checkout', async () => {
    const before = git('rev-parse', 'HEAD');
    const { session, plan } = await createdPlan();
    expect(await readdir(plan.targetPath)).toEqual(['.git']);
    const report = await hydration.inspect(session.id, plan.id);
    expect(report).toMatchObject({
      state: 'ready', fileCount: 2, executionEnabled: false,
    });
    expect(report.fingerprint).toMatch(/^sha256:/);
    const grant = await hydration.authorize(session.id, plan.id, {
      fingerprint: report.fingerprint, operatorSecret: SECRET,
    });
    expect(grant.purpose).toBe('HYDRATE_SAFE_BLOBS_ONLY');
    const attempts = await Promise.allSettled([
      hydration.hydrate(session.id, plan.id, { grantToken: grant.grantToken }),
      hydration.hydrate(session.id, plan.id, { grantToken: grant.grantToken }),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const hydrated = (await plans.list(session.id))[0];
    expect(hydrated.state).toBe('hydrated');
    expect(hydrated.hydratedFileCount).toBe(2);
    expect(hydrated.worktreeCreated).toBe(true);
    expect(hydrated.executionEnabled).toBe(false);
    expect((await readFile(join(plan.targetPath, 'README.md'), 'utf8'))).toBe('# fixture\n');
    expect((await readFile(join(plan.targetPath, 'src', 'index.ts'), 'utf8')))
      .toBe('export const number = 7;\n');
    expect(git('status', '--porcelain')).toBe('');
    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect((await hydration.inspect(session.id, plan.id)).state).toBe('hydrated');
    expect(hydrated.history.map((event) => event.event).slice(-2))
      .toEqual(['hydration-started', 'hydration-completed']);
  });

  it('defaults to disabled and rejects incorrect operator secrets', async () => {
    const { session, plan } = await createdPlan();
    const report = await hydration.inspect(session.id, plan.id);
    process.env.DEV_HUB_ENABLE_WORKTREE_HYDRATION = 'false';
    await expect(hydration.authorize(session.id, plan.id, {
      fingerprint: report.fingerprint, operatorSecret: SECRET,
    })).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_WORKTREE_HYDRATION = 'true';
    await expect(hydration.authorize(session.id, plan.id, {
      fingerprint: report.fingerprint, operatorSecret: 'wrong-secret-with-length-more-than-32-chars',
    })).rejects.toThrow('Невірний секрет');
  });

  it('never overwrites foreign files or retries a failed hydration', async () => {
    const { session, plan } = await createdPlan();
    const report = await hydration.inspect(session.id, plan.id);
    const grant = await hydration.authorize(session.id, plan.id, {
      fingerprint: report.fingerprint, operatorSecret: SECRET,
    });
    await writeFile(join(plan.targetPath, 'foreign.txt'), 'must survive');
    await expect(hydration.hydrate(session.id, plan.id, {
      grantToken: grant.grantToken,
    })).rejects.toThrow('Наповнення перервано');
    const state = (await plans.list(session.id))[0];
    expect(state.state).toBe('hydrate-failed');
    expect((await readFile(join(plan.targetPath, 'foreign.txt'), 'utf8'))).toBe('must survive');
    expect((await hydration.inspect(session.id, plan.id)).state).toBe('manual-review');
    await expect(hydration.hydrate(session.id, plan.id, { grantToken: grant.grantToken }))
      .rejects.toThrow('Дозвіл недійсний');
  });

  it('keeps a crashed operation under manual review, never deleting data', async () => {
    const { session, plan } = await createdPlan();
    const report = await hydration.inspect(session.id, plan.id);
    await plans.reserveHydration(session.id, plan.id, report.fingerprint!);
    await writeFile(join(plan.targetPath, 'partial.txt'), 'recover manually');
    const resumed = new WorktreeHydrationService(plans);
    expect((await resumed.inspect(session.id, plan.id)).state).toBe('manual-review');
    expect((await readFile(join(plan.targetPath, 'partial.txt'), 'utf8'))).toBe('recover manually');
    expect((await plans.list(session.id))[0].state).toBe('hydrating');
  });

  it('rejects a changed worktree commit before writing any files', async () => {
    const { session, plan } = await createdPlan();
    const branch = execFileSync('git', ['-C', plan.targetPath, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(branch).toBe(plan.baseHeadSha);
    execFileSync('git', ['-C', plan.targetPath, 'symbolic-ref', 'HEAD', 'refs/heads/untrusted'], { stdio: 'ignore' });
    const report = await hydration.inspect(session.id, plan.id);
    expect(report.state).toBe('blocked');
    expect(await readdir(plan.targetPath)).toEqual(['.git']);
  });
});
