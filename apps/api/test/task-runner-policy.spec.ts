import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { WorktreePlan, WorktreeIntegrityReport } from '@gym-dev-hub/contracts';
import { TaskRunnerPolicyService } from '../src/worktree/task-runner-policy.service.js';

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);

describe('fixed task runner policy preview', () => {
  const plan: WorktreePlan = {
    id: PLAN,
    sessionId: SESSION,
    repository: 'sauron9521/gym-platform',
    sourcePath: '/fixture/gym-platform',
    targetPath: '/fixture/worktree',
    proposedBranch: 'devhub/preview',
    fingerprint: FINGERPRINT,
    state: 'created',
    createdAt: new Date().toISOString(),
    expiresAt: null,
    history: [],
    worktreeCreated: true,
    executionEnabled: false,
    hydrationState: 'completed',
    baseHeadSha: 'a'.repeat(40),
  };
  const report: WorktreeIntegrityReport = {
    sessionId: SESSION,
    planId: PLAN,
    status: 'verified',
    checkedAt: new Date().toISOString(),
    fileCount: 10,
    verifiedBytes: 1280,
    findings: [],
    mount: {
      sourcePath: plan.targetPath,
      targetPath: '/workspace',
      readOnly: true,
      networkEnabled: false,
      mountEnabled: false,
      executionEnabled: false,
    },
  };
  const plans = { availableForMountProbe: vi.fn() };
  const integrity = { verify: vi.fn() };
  let service: TaskRunnerPolicyService;

  beforeEach(() => {
    vi.resetAllMocks();
    plans.availableForMountProbe.mockResolvedValue({ ...plan });
    integrity.verify.mockResolvedValue({ ...report });
    service = new TaskRunnerPolicyService(plans as never, integrity as never);
  });

  const request = (recipeId = 'API_TEST') => ({ recipeId, fingerprint: FINGERPRINT });

  it.each([
    ['API_TEST', ['pnpm', '--filter', '@gym/api', 'test']],
    ['API_TYPECHECK', ['pnpm', '--filter', '@gym/api', 'typecheck']],
    ['API_LINT', ['pnpm', '--filter', '@gym/api', 'lint']],
    ['WEB_TEST', ['pnpm', '--filter', '@gym/web', 'test']],
    ['WEB_TYPECHECK', ['pnpm', '--filter', '@gym/web', 'typecheck']],
    ['WEB_LINT', ['pnpm', '--filter', '@gym/web', 'lint']],
  ])('previews only fixed argv for %s without executing anything', async (recipeId, argv) => {
    const preview = await service.preview(SESSION, PLAN, request(recipeId));
    expect(preview).toMatchObject({
      sessionId: SESSION,
      planId: PLAN,
      recipeId,
      argv,
      baseHeadSha: plan.baseHeadSha,
      fingerprint: FINGERPRINT,
      status: 'preview-only',
      executionEnabled: false,
      approvalGranted: false,
      runnerImageAvailable: false,
      executesUntrustedProjectScripts: true,
      proposedBoundary: {
        sourceMount: 'read-only',
        network: 'none',
        dockerSocket: false,
        environmentSecrets: false,
      },
    });
    expect(preview.notes).toHaveLength(4);
    expect(plans.availableForMountProbe).toHaveBeenCalledWith(SESSION, PLAN);
    expect(integrity.verify).toHaveBeenCalledWith(SESSION, PLAN);
  });

  it('rejects arbitrary shell commands, extra fields, unknown recipes and altered fingerprints', async () => {
    for (const input of [
      { ...request(), command: 'sh' },
      { ...request(), args: ['--script', 'install'] },
      { ...request(), recipeId: 'CUSTOM' },
      { ...request(), fingerprint: 'sha256:' + 'c'.repeat(64) },
      { ...request(), fingerprint: 'not-a-hash' },
      { ...request(), shell: true },
    ]) {
      await expect(service.preview(SESSION, PLAN, input)).rejects.toThrow();
    }
  });

  it('refuses another repository or changed pinned commit', async () => {
    plans.availableForMountProbe.mockResolvedValueOnce({
      ...plan,
      repository: 'sauron9521/gym-dev-hub',
    });
    await expect(service.preview(SESSION, PLAN, request())).rejects.toThrow('План worktree');
    plans.availableForMountProbe.mockResolvedValueOnce({ ...plan, baseHeadSha: null });
    await expect(service.preview(SESSION, PLAN, request())).rejects.toThrow('План worktree');
  });

  it('fails closed on integrity mismatch, changed mount and network request', async () => {
    integrity.verify.mockResolvedValueOnce({ ...report, status: 'mismatch' });
    await expect(service.preview(SESSION, PLAN, request())).rejects.toThrow(
      'перевірка Git worktree',
    );
    integrity.verify.mockResolvedValueOnce({
      ...report,
      mount: { ...report.mount, sourcePath: '/outside' },
    });
    await expect(service.preview(SESSION, PLAN, request())).rejects.toThrow(
      'перевірка Git worktree',
    );
    integrity.verify.mockResolvedValueOnce({
      ...report,
      mount: { ...report.mount, networkEnabled: true },
    });
    await expect(service.preview(SESSION, PLAN, request())).rejects.toThrow(
      'перевірка Git worktree',
    );
  });

  it('never generates approval tokens, process handles or executable state', async () => {
    const data = await service.preview(SESSION, PLAN, request());
    expect('grantToken' in data).toBe(false);
    expect('pid' in data).toBe(false);
    expect('runId' in data).toBe(false);
    expect(data.executionEnabled).toBe(false);
  });
});
