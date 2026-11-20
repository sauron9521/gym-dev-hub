import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreePlan, WorktreeIntegrityReport } from '@gym-dev-hub/contracts';
import { WorktreeToolService } from '../src/worktree/worktree-tool.service.js';
import { runMountedWorkerProbe } from '../src/worktree/worktree-mount-probe.js';

vi.mock('../src/worktree/worktree-mount-probe.js', async (original) => ({
  ...(await original<typeof import('../src/worktree/worktree-mount-probe.js')>()),
  runMountedWorkerProbe: vi.fn(),
}));

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const SECRET = 'separate-worker-tool-test-secret-abcdefghijklmnopqrstuvwxyz';
const DIGEST = 'a'.repeat(64);

describe('separate one-shot fixed worker tool approval', () => {
  let root: string;
  let plan: WorktreePlan;
  let plans: {
    availableForMountProbe: ReturnType<typeof vi.fn>;
    recordToolRun: ReturnType<typeof vi.fn>;
  };
  let integrity: { verify: ReturnType<typeof vi.fn> };
  let boundary: { status: ReturnType<typeof vi.fn> };
  let service: WorktreeToolService;

  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(join(tmpdir(), 'devhub-tool-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'test.ts'), 'export const value = 1;\n');
    process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT = 'true';
    process.env.DEV_HUB_ENABLE_WORKER_TOOLS = 'true';
    process.env.DEV_HUB_WORKER_TOOL_SECRET = SECRET;
    plan = {
      id: PLAN,
      sessionId: SESSION,
      repository: 'sauron9521/gym-platform',
      sourcePath: root,
      targetPath: root,
      proposedBranch: 'devhub/tool-test',
      fingerprint: FINGERPRINT,
      state: 'created',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      history: [],
      executionEnabled: false,
      worktreeCreated: true,
      hydrationState: 'completed',
      baseHeadSha: 'a'.repeat(40),
    };
    plans = {
      availableForMountProbe: vi.fn().mockResolvedValue(plan),
      recordToolRun: vi.fn().mockResolvedValue(undefined),
    };
    const report: WorktreeIntegrityReport = {
      sessionId: SESSION,
      planId: PLAN,
      status: 'verified',
      checkedAt: new Date().toISOString(),
      fileCount: 1,
      verifiedBytes: 24,
      findings: [],
      mount: {
        sourcePath: root,
        targetPath: '/workspace',
        readOnly: true,
        networkEnabled: false,
        mountEnabled: false,
        executionEnabled: false,
      },
    };
    integrity = { verify: vi.fn().mockResolvedValue(report) };
    boundary = {
      status: vi.fn().mockReturnValue({ state: 'passed', checkedAt: new Date().toISOString() }),
    };
    service = new WorktreeToolService(plans as never, integrity as never, boundary as never);
    vi.mocked(runMountedWorkerProbe).mockResolvedValue(DIGEST);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    delete process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT;
    delete process.env.DEV_HUB_ENABLE_WORKER_TOOLS;
    delete process.env.DEV_HUB_WORKER_TOOL_SECRET;
  });

  const request = () => ({
    fingerprint: FINGERPRINT,
    tool: 'SHA256_FILE',
    filePath: 'src/test.ts',
    operatorSecret: SECRET,
  });

  it('executes only approved SHA256_FILE and records durable lifecycle', async () => {
    const grant = await service.authorize(SESSION, PLAN, request());
    expect(grant).toMatchObject({
      purpose: 'RUN_FIXED_WORKER_TOOL',
      tool: 'SHA256_FILE',
      filePath: 'src/test.ts',
      baseHeadSha: plan.baseHeadSha,
    });
    const result = await service.execute(SESSION, PLAN, { grantToken: grant.grantToken });
    expect(result).toMatchObject({
      sha256: DIGEST,
      tool: 'SHA256_FILE',
      filePath: 'src/test.ts',
      arbitraryCommandExecutionEnabled: false,
      repositoryCodeExecutionEnabled: false,
      readOnly: true,
      networkEnabled: false,
      containerRemoved: true,
    });
    expect(runMountedWorkerProbe).toHaveBeenCalledWith(root, undefined, 'src/test.ts');
    expect(plans.recordToolRun.mock.calls.map(([, , step]) => step)).toEqual([
      'started',
      'completed',
    ]);
    await expect(service.execute(SESSION, PLAN, { grantToken: grant.grantToken })).rejects.toThrow(
      'використано',
    );
  });

  it('refuses arbitrary tools, invalid path, extra fields and weak independent secret', async () => {
    await expect(
      service.authorize(SESSION, PLAN, { ...request(), tool: 'SHELL' }),
    ).rejects.toThrow();
    await expect(
      service.authorize(SESSION, PLAN, { ...request(), filePath: '../secret.ts' }),
    ).rejects.toThrow();
    await expect(
      service.authorize(SESSION, PLAN, { ...request(), args: ['--privileged'] }),
    ).rejects.toThrow();
    await expect(
      service.authorize(SESSION, PLAN, {
        ...request(),
        operatorSecret: 'invalid-long-secret-abcdefghijklmnopqrstuvwxyz',
      }),
    ).rejects.toThrow('секрет');
    expect(runMountedWorkerProbe).not.toHaveBeenCalled();
  });

  it('does not accept the regular read permission flags as authorization', async () => {
    delete process.env.DEV_HUB_ENABLE_WORKER_TOOLS;
    process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ = 'true';
    await expect(service.authorize(SESSION, PLAN, request())).rejects.toThrow('вимкнено');
    delete process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ;
  });

  it('requires fresh Docker preflight and verified Git blob integrity', async () => {
    boundary.status.mockReturnValue({
      state: 'passed',
      checkedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    });
    await expect(service.authorize(SESSION, PLAN, request())).rejects.toThrow('Docker Safety');
    boundary.status.mockReturnValue({ state: 'passed', checkedAt: new Date().toISOString() });
    const grant = await service.authorize(SESSION, PLAN, request());
    integrity.verify.mockResolvedValueOnce({ status: 'mismatch' });
    await expect(service.execute(SESSION, PLAN, { grantToken: grant.grantToken })).rejects.toThrow(
      'Docker tool',
    );
    expect(runMountedWorkerProbe).not.toHaveBeenCalled();
  });

  it('rejects unknown files and bounded-size violations before issuing a grant', async () => {
    await expect(
      service.authorize(SESSION, PLAN, { ...request(), filePath: 'src/nope.ts' }),
    ).rejects.toThrow();
    await writeFile(join(root, 'src', 'large.ts'), 'x'.repeat(8193));
    await expect(
      service.authorize(SESSION, PLAN, { ...request(), filePath: 'src/large.ts' }),
    ).rejects.toThrow();
  });

  it('fails closed if the worker returns unexpected content or errors', async () => {
    const grant = await service.authorize(SESSION, PLAN, request());
    vi.mocked(runMountedWorkerProbe).mockResolvedValueOnce('not-a-checksum');
    await expect(service.execute(SESSION, PLAN, { grantToken: grant.grantToken })).rejects.toThrow(
      'Docker tool',
    );
    expect(plans.recordToolRun.mock.calls.map(([, , step]) => step)).toEqual(['started', 'failed']);
  });

  it('consumes grants on cross-session attempts, timeout and replay', async () => {
    const grant = await service.authorize(SESSION, PLAN, request());
    await expect(
      service.execute('00000000-0000-4000-8000-000000000999', PLAN, {
        grantToken: grant.grantToken,
      }),
    ).rejects.toThrow('використано');
    await expect(service.execute(SESSION, PLAN, { grantToken: grant.grantToken })).rejects.toThrow(
      'використано',
    );
    const second = await service.authorize(SESSION, PLAN, request());
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await expect(service.execute(SESSION, PLAN, { grantToken: second.grantToken })).rejects.toThrow(
      'прострочено',
    );
    expect(runMountedWorkerProbe).not.toHaveBeenCalled();
  });
});
