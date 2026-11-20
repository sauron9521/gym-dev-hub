import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreePlan, WorktreeIntegrityReport } from '@gym-dev-hub/contracts';
import { WorktreeMountService } from '../src/worktree/worktree-mount.service.js';
import { runMountedWorkerProbe } from '../src/worktree/worktree-mount-probe.js';

vi.mock('../src/worktree/worktree-mount-probe.js', () => ({
  runMountedWorkerProbe: vi.fn(),
}));

const SECRET = 'test-operator-secret-abcdefghijklmnopqrstuvwxyz-1234567890';
const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';

describe('ephemeral read-only mount approval', () => {
  let service: WorktreeMountService;
  let plans: {
    availableForMountProbe: ReturnType<typeof vi.fn>;
    recordMountProbe: ReturnType<typeof vi.fn>;
  };
  let integrity: { verify: ReturnType<typeof vi.fn> };
  let boundary: { status: ReturnType<typeof vi.fn> };
  let plan: WorktreePlan;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT = 'true';
    process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET = SECRET;
    plan = {
      id: PLAN,
      sessionId: SESSION,
      repository: 'sauron9521/gym-platform',
      sourcePath: '/fixture/gym-platform',
      targetPath: '/fixture/worktrees/' + PLAN,
      proposedBranch: 'devhub/task-' + PLAN.replaceAll('-', ''),
      fingerprint: 'sha256:' + 'b'.repeat(64),
      state: 'created', createdAt: new Date().toISOString(),
      expiresAt: null, history: [], executionEnabled: false,
      worktreeCreated: true, hydrationState: 'completed', baseHeadSha: 'a'.repeat(40),
    };
    plans = {
      availableForMountProbe: vi.fn().mockResolvedValue(plan),
      recordMountProbe: vi.fn().mockResolvedValue(undefined),
    };
    const report: WorktreeIntegrityReport = {
      sessionId: SESSION, planId: PLAN, checkedAt: new Date().toISOString(),
      status: 'verified', fileCount: 4, verifiedBytes: 120, findings: [],
      mount: {
        sourcePath: plan.targetPath, targetPath: '/workspace', readOnly: true,
        networkEnabled: false, mountEnabled: false, executionEnabled: false,
      },
    };
    integrity = { verify: vi.fn().mockResolvedValue(report) };
    boundary = { status: vi.fn().mockReturnValue({
      state: 'passed', checkedAt: new Date().toISOString(),
    }) };
    service = new WorktreeMountService(plans as never, integrity as never, boundary as never);
    vi.mocked(runMountedWorkerProbe).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT;
    delete process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET;
  });

  const request = () => ({ fingerprint: 'sha256:' + 'b'.repeat(64), operatorSecret: SECRET });

  it('runs a single ephemeral read-only probe and records its lifecycle', async () => {
    const grant = await service.authorize(SESSION, PLAN, request());
    expect(grant).toMatchObject({
      purpose: 'EPHEMERAL_READ_ONLY_WORKER_MOUNT',
      baseHeadSha: plan.baseHeadSha,
    });
    const [a,b] = await Promise.allSettled([
      service.probe(SESSION, PLAN, { grantToken: grant.grantToken }),
      service.probe(SESSION, PLAN, { grantToken: grant.grantToken }),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    if (a.status === 'fulfilled') {
      expect(a.value).toMatchObject({
        state: 'verified', sourcePath: plan.targetPath, targetPath: '/workspace',
        readOnly: true, networkEnabled: false, containerRemoved: true,
        agentExecutionEnabled: false,
      });
    }
    expect(runMountedWorkerProbe).toHaveBeenCalledOnce();
    expect(runMountedWorkerProbe).toHaveBeenCalledWith(plan.targetPath);
    expect(plans.recordMountProbe.mock.calls.map(([,,stage]) => stage))
      .toEqual(['started', 'verified']);
  });

  it('fails closed without explicit opt-in or strong secret', async () => {
    process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT = 'false';
    await expect(service.authorize(SESSION, PLAN, request())).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT = 'true';
    process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET = 'weak';
    await expect(service.authorize(SESSION, PLAN, request())).rejects.toThrow('секрет');
    expect(runMountedWorkerProbe).not.toHaveBeenCalled();
  });

  it('denies the wrong operator secret and stale boundary before issuing a grant', async () => {
    await expect(service.authorize(SESSION, PLAN, {
      fingerprint: plan.fingerprint, operatorSecret: 'wrong-long-operator-secret-12345678901234567890',
    })).rejects.toThrow('Невірний секрет');
    boundary.status.mockReturnValue({
      state: 'passed', checkedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    });
    await expect(service.authorize(SESSION, PLAN, request())).rejects.toThrow('Docker Safety');
    expect(integrity.verify).not.toHaveBeenCalled();
  });

  it('rejects a changed manifest or integrity report', async () => {
    const grant = await service.authorize(SESSION, PLAN, request());
    integrity.verify.mockResolvedValueOnce({
      status: 'mismatch', mount: { sourcePath: plan.targetPath },
    });
    await expect(service.probe(SESSION, PLAN, { grantToken: grant.grantToken }))
      .rejects.toThrow('Docker mount probe');
    expect(runMountedWorkerProbe).not.toHaveBeenCalled();
    expect(plans.recordMountProbe).not.toHaveBeenCalled();
  });

  it('consumes expired and cross-session grants even when probe does not start', async () => {
    const first = await service.authorize(SESSION, PLAN, request());
    await expect(service.probe('00000000-0000-4000-8000-000000000999', PLAN, {
      grantToken: first.grantToken,
    })).rejects.toThrow('Дозвіл прострочено');
    await expect(service.probe(SESSION, PLAN, {
      grantToken: first.grantToken,
    })).rejects.toThrow('Дозвіл прострочено');
    const second = await service.authorize(SESSION, PLAN, request());
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await expect(service.probe(SESSION, PLAN, {
      grantToken: second.grantToken,
    })).rejects.toThrow('Дозвіл прострочено');
    expect(runMountedWorkerProbe).not.toHaveBeenCalled();
  });

  it('records failure and never reports success when Docker rejects the mount', async () => {
    const grant = await service.authorize(SESSION, PLAN, request());
    vi.mocked(runMountedWorkerProbe).mockRejectedValueOnce(new Error('unsafe mount'));
    await expect(service.probe(SESSION, PLAN, {
      grantToken: grant.grantToken,
    })).rejects.toThrow('Docker mount probe');
    expect(plans.recordMountProbe.mock.calls.map(([,,stage]) => stage))
      .toEqual(['started', 'failed']);
  });

  it('revokes previously issued tokens after the feature is disabled', async () => {
    const grant = await service.authorize(SESSION, PLAN, request());
    process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT = 'false';
    await expect(service.probe(SESSION, PLAN, {
      grantToken: grant.grantToken,
    })).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT = 'true';
    await expect(service.probe(SESSION, PLAN, {
      grantToken: grant.grantToken,
    })).rejects.toThrow('Дозвіл прострочено');
  });
});
