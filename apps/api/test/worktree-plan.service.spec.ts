import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { GitHubService } from '../src/github/github.service.js';
import { WorkspaceService } from '../src/workspace/workspace.service.js';
import { CodexBridgeService } from '../src/codex/codex-bridge.service.js';
import {
  WorktreePlanService,
  verifyLocalRepository,
} from '../src/worktree/worktree-plan.service.js';

describe('worktree manifest and approval foundation', () => {
  let folder: string;
  let worktreeRoot: string;
  let service: WorktreePlanService;
  let workspace: WorkspaceService;
  let plansFile: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'devhub-worktrees-'));
    const repo = join(folder, 'repos', 'gym-platform');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(
      join(repo, '.git', 'config'),
      '[core]\n  bare = false\n[remote "origin"]\n  url = https://github.com/sauron9521/gym-platform.git\n[branch "main"]\n  remote = origin\n',
      'utf8',
    );
    worktreeRoot = join(folder, 'devhub', '.local', 'worktrees');
    plansFile = join(folder, 'devhub', '.local', 'plans.json');
    process.env.DEV_HUB_REPOS_ROOT = join(folder, 'repos');
    process.env.DEV_HUB_WORKTREES_ROOT = worktreeRoot;
    process.env.DEV_HUB_PLAN_FILE = plansFile;
    process.env.DEV_HUB_WORKSPACE_FILE = join(folder, 'devhub', '.local', 'sessions.json');
    process.env.GITHUB_REPOSITORIES = 'sauron9521/gym-platform,sauron9521/gym-dev-hub';
    const github = new GitHubService();
    workspace = new WorkspaceService(github, new CodexBridgeService());
    service = new WorktreePlanService(workspace, github);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const env of [
      'DEV_HUB_REPOS_ROOT',
      'DEV_HUB_WORKTREES_ROOT',
      'DEV_HUB_PLAN_FILE',
      'DEV_HUB_WORKSPACE_FILE',
      'GITHUB_REPOSITORIES',
    ])
      delete process.env[env];
    await rm(folder, { recursive: true, force: true });
  });

  async function session() {
    return workspace.create({
      title: 'API slice',
      task: 'Create a scoped worktree manifest for one small PR',
      repository: 'sauron9521/gym-platform',
    });
  }

  it('plans immutable, scoped paths without creating worktrees or git branches', async () => {
    const owner = await session();
    const plan = await service.create(owner.id);
    expect(plan).toMatchObject({
      sessionId: owner.id,
      repository: 'sauron9521/gym-platform',
      state: 'pending',
      executionEnabled: false,
      worktreeCreated: false,
    });
    expect(plan.sourcePath).toBe(join(folder, 'repos', 'gym-platform'));
    expect(plan.targetPath).toBe(join(worktreeRoot, plan.id));
    expect(plan.proposedBranch).toMatch(/^devhub\/task-[0-9a-f]{32}$/);
    expect(plan.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.history.map((event) => event.event)).toEqual(['created']);
    await expect(lstat(plan.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const restored = new WorktreePlanService(workspace, new GitHubService());
    expect((await restored.list(owner.id))[0].fingerprint).toBe(plan.fingerprint);
  });

  it('requires exact fingerprint and explicit confirmation, rejects replay and allows revocation', async () => {
    const owner = await session();
    const plan = await service.create(owner.id);
    await expect(
      service.acknowledge(owner.id, plan.id, {
        fingerprint: 'sha256:' + 'a'.repeat(64),
        confirmation: 'I_APPROVE_THIS_PLAN_ONLY',
      }),
    ).rejects.toThrow('Маніфест змінився');
    await expect(
      service.acknowledge(owner.id, plan.id, {
        fingerprint: plan.fingerprint,
        confirmation: 'yes',
      }),
    ).rejects.toThrow();
    const confirmed = await service.acknowledge(owner.id, plan.id, {
      fingerprint: plan.fingerprint,
      confirmation: 'I_APPROVE_THIS_PLAN_ONLY',
    });
    expect(confirmed.state).toBe('acknowledged');
    expect(Date.parse(confirmed.expiresAt!)).toBeGreaterThan(Date.now());
    expect(confirmed.history.map((event) => event.event)).toEqual(['created', 'acknowledged']);
    await expect(
      service.acknowledge(owner.id, plan.id, {
        fingerprint: plan.fingerprint,
        confirmation: 'I_APPROVE_THIS_PLAN_ONLY',
      }),
    ).rejects.toThrow('уже погоджено');
    const revoked = await service.revoke(owner.id, plan.id, {});
    expect(revoked.state).toBe('revoked');
    expect(revoked.history.map((event) => event.event)).toEqual([
      'created',
      'acknowledged',
      'revoked',
    ]);
    expect((await service.create(owner.id)).id).not.toBe(plan.id);
  });

  it('expires an unapproved plan and refuses late approval', async () => {
    const owner = await session();
    const plan = await service.create(owner.id);
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 16 * 60_000);
    const [expired] = await service.list(owner.id);
    expect(expired.state).toBe('expired');
    await expect(
      service.acknowledge(owner.id, plan.id, {
        fingerprint: plan.fingerprint,
        confirmation: 'I_APPROVE_THIS_PLAN_ONLY',
      }),
    ).rejects.toThrow('уже погоджено');
    expect((await service.create(owner.id)).state).toBe('pending');
  });

  it('expires an acknowledged plan and preserves its audit trail', async () => {
    const owner = await session();
    const plan = await service.create(owner.id);
    await service.acknowledge(owner.id, plan.id, {
      fingerprint: plan.fingerprint,
      confirmation: 'I_APPROVE_THIS_PLAN_ONLY',
    });
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 16 * 60_000);
    const plans = await service.list(owner.id);
    expect(plans[0].state).toBe('expired');
    expect(plans[0].history.map((e) => e.event)).toEqual(['created', 'acknowledged']);
  });

  it('rejects incorrect Git origin and disallows worktree-like .git files', async () => {
    const source = join(folder, 'repos', 'gym-platform');
    await writeFile(
      join(source, '.git', 'config'),
      '[remote "upstream"]\n url = https://github.com/sauron9521/gym-platform\n[remote "origin"]\n url = https://github.com/other/other.git\n',
    );
    const owner = await session();
    await expect(service.create(owner.id)).rejects.toThrow('Git origin');
    await rm(join(source, '.git'), { recursive: true, force: true });
    await writeFile(join(source, '.git'), 'gitdir: /private/other');
    await expect(service.create(owner.id)).rejects.toThrow('Недозволений формат');
  });

  it('accepts an SSH GitHub origin without leaking URLs to the client', async () => {
    const source = join(folder, 'repos', 'gym-platform');
    await writeFile(
      join(source, '.git', 'config'),
      '[remote "origin"]\n url = git@github.com:sauron9521/gym-platform.git\n',
    );
    expect(await verifyLocalRepository('sauron9521/gym-platform', join(folder, 'repos'))).toBe(
      source,
    );
    const owner = await session();
    const plan = await service.create(owner.id);
    expect(JSON.stringify(plan)).not.toContain('git@');
  });

  it('prevents duplicate concurrent plans and cross-session approval', async () => {
    const owner = await session();
    const second = await session();
    const results = await Promise.allSettled([service.create(owner.id), service.create(owner.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await service.list(owner.id)).toHaveLength(1);
    const created = (await service.list(owner.id))[0];
    await expect(
      service.acknowledge(second.id, created.id, {
        fingerprint: created.fingerprint,
        confirmation: 'I_APPROVE_THIS_PLAN_ONLY',
      }),
    ).rejects.toThrow('не знайдено');
  });

  it('rejects plan creation for completed sessions', async () => {
    const owner = await session();
    await workspace.update(owner.id, { status: 'completed' });
    await expect(service.create(owner.id)).rejects.toThrow('завершеної');
  });

  it('preserves corrupted manifest data and does not initialize an empty store over it', async () => {
    const original = '{unparseable-json';
    await mkdir(join(folder, 'devhub', '.local'), { recursive: true });
    await writeFile(plansFile, original);
    const owner = await session();
    await expect(service.create(owner.id)).rejects.toThrow('Файл маніфестів пошкоджено');
    expect(await readFile(plansFile, 'utf8')).toBe(original);
  });

  it('rejects path escaping via a linked repository', async () => {
    const source = join(folder, 'repos', 'gym-platform');
    await rm(source, { recursive: true, force: true });
    const external = join(folder, 'external');
    await mkdir(join(external, '.git'), { recursive: true });
    await writeFile(
      join(external, '.git', 'config'),
      '[remote "origin"]\nurl = https://github.com/sauron9521/gym-platform\n',
    );
    // Junctions work without Windows developer mode, unlike file symlinks.
    const { symlink } = await import('node:fs/promises');
    await symlink(external, source, process.platform === 'win32' ? 'junction' : 'dir');
    const owner = await session();
    await expect(service.create(owner.id)).rejects.toThrow('поза дозволеною');
  });
});
