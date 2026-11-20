import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeIntegrityReport, WorktreePlan } from '@gym-dev-hub/contracts';
import { WorktreeCodeReadService } from '../src/worktree/worktree-code-read.service.js';
import { runMountedWorkerProbe } from '../src/worktree/worktree-mount-probe.js';
import { withPinnedFileStage } from '../src/worktree/worktree-file-stage.js';

vi.mock('../src/worktree/worktree-file-stage.js', () => ({ withPinnedFileStage: vi.fn() }));

vi.mock('../src/worktree/worktree-mount-probe.js', async (original) => ({
  ...(await original<typeof import('../src/worktree/worktree-mount-probe.js')>()),
  runMountedWorkerProbe: vi.fn(),
}));

const SECRET = 'test-read-secret-abcdefghijklmnopqrstuvwxyz-1234567890';
const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);

describe('explicit scoped code-reading authorization', () => {
  let root: string;
  let service: WorktreeCodeReadService;
  let plans: {
    availableForMountProbe: ReturnType<typeof vi.fn>;
    recordCodeRead: ReturnType<typeof vi.fn>;
  };
  let integrity: { verify: ReturnType<typeof vi.fn> };
  let boundary: { status: ReturnType<typeof vi.fn> };
  let plan: WorktreePlan;

  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(join(tmpdir(), 'devhub-read-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'main.ts'), 'export const ready = true;\n');
    process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT = 'true';
    process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ = 'true';
    process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET = SECRET;
    plan = {
      id: PLAN,
      sessionId: SESSION,
      repository: 'sauron9521/gym-platform',
      sourcePath: root,
      targetPath: root,
      proposedBranch: 'devhub/task-123',
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
      recordCodeRead: vi.fn().mockResolvedValue(undefined),
    };
    const report: WorktreeIntegrityReport = {
      sessionId: SESSION,
      planId: PLAN,
      checkedAt: new Date().toISOString(),
      status: 'verified',
      fileCount: 1,
      verifiedBytes: 27,
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
    service = new WorktreeCodeReadService(plans as never, integrity as never, boundary as never);
    vi.mocked(runMountedWorkerProbe).mockResolvedValue('export const ready = true;\n');
    vi.mocked(withPinnedFileStage).mockImplementation(async (_plan, _path, action) =>
      action({
        sourcePath: join(root, 'single-use-stage'),
        fileName: 'main.ts',
        bytes: Buffer.from('export const ready = true;\n'),
        sha256: 'a'.repeat(64),
      }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    delete process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT;
    delete process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ;
    delete process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET;
  });

  const request = (filePath = 'src/main.ts') => ({
    fingerprint: FINGERPRINT,
    filePath,
    operatorSecret: SECRET,
  });

  it('reads only the explicitly approved file and consumes the grant once', async () => {
    const grant = await service.authorize(SESSION, PLAN, request());
    expect(grant).toMatchObject({ filePath: 'src/main.ts', purpose: 'READ_ONE_SCOPED_CODE_FILE' });
    const result = await service.read(SESSION, PLAN, { grantToken: grant.grantToken });
    expect(result).toMatchObject({
      filePath: 'src/main.ts',
      content: 'export const ready = true;\n',
      readOnly: true,
      networkEnabled: false,
      agentExecutionEnabled: false,
      containerRemoved: true,
    });
    expect(runMountedWorkerProbe).toHaveBeenCalledWith(join(root, 'single-use-stage'), 'main.ts');
    expect(plans.recordCodeRead.mock.calls.map(([, , step]) => step)).toEqual([
      'started',
      'completed',
    ]);
    await expect(service.read(SESSION, PLAN, { grantToken: grant.grantToken })).rejects.toThrow(
      'вже використано',
    );
  });

  it.each([
    '../secrets.ts',
    '/etc/passwd',
    '.env',
    '.git/config.json',
    'src//main.ts',
    'src/../main.ts',
    'src/main.ts;whoami',
    'src/main.exe',
  ])('rejects invalid paths without starting Docker: %s', async (filePath) => {
    await expect(service.authorize(SESSION, PLAN, request(filePath))).rejects.toThrow();
    expect(runMountedWorkerProbe).not.toHaveBeenCalled();
  });

  it('requires separate opt-in and a strong operator secret', async () => {
    delete process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ;
    await expect(service.authorize(SESSION, PLAN, request())).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ = 'true';
    await expect(
      service.authorize(SESSION, PLAN, {
        ...request(),
        operatorSecret: 'not-the-actual-secret-123456789123456789',
      }),
    ).rejects.toThrow('Невірний секрет');
    expect(runMountedWorkerProbe).not.toHaveBeenCalled();
  });

  it('refuses stale preflight, integrity drift and file changes', async () => {
    boundary.status.mockReturnValue({
      state: 'passed',
      checkedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    });
    await expect(service.authorize(SESSION, PLAN, request())).rejects.toThrow('Safety Preflight');
    boundary.status.mockReturnValue({ state: 'passed', checkedAt: new Date().toISOString() });
    const grant = await service.authorize(SESSION, PLAN, request());
    await writeFile(join(root, 'src', 'main.ts'), 'drift');
    integrity.verify.mockResolvedValueOnce({ status: 'mismatch' });
    await expect(service.read(SESSION, PLAN, { grantToken: grant.grantToken })).rejects.toThrow(
      'Scoped read',
    );
    expect(runMountedWorkerProbe).not.toHaveBeenCalled();
  });

  it('fails closed on missing files, oversize files and symlinks', async () => {
    await expect(service.authorize(SESSION, PLAN, request('src/missing.ts'))).rejects.toThrow();
    await writeFile(join(root, 'src', 'big.ts'), 'A'.repeat(8193));
    await expect(service.authorize(SESSION, PLAN, request('src/big.ts'))).rejects.toThrow();
  });

  it('records Docker protocol failures without leaking partial source text', async () => {
    const grant = await service.authorize(SESSION, PLAN, request());
    vi.mocked(runMountedWorkerProbe).mockRejectedValueOnce(new Error('Docker denied'));
    await expect(service.read(SESSION, PLAN, { grantToken: grant.grantToken })).rejects.toThrow(
      'Scoped read',
    );
    expect(plans.recordCodeRead.mock.calls.map(([, , step]) => step)).toEqual([
      'started',
      'failed',
    ]);
  });

  it('rejects cross-session and expired grants even when the file remains valid', async () => {
    const grant = await service.authorize(SESSION, PLAN, request());
    await expect(
      service.read('00000000-0000-4000-8000-000000000999', PLAN, { grantToken: grant.grantToken }),
    ).rejects.toThrow('вже використано');
    await expect(service.read(SESSION, PLAN, { grantToken: grant.grantToken })).rejects.toThrow(
      'вже використано',
    );
    const expiring = await service.authorize(SESSION, PLAN, request());
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await expect(service.read(SESSION, PLAN, { grantToken: expiring.grantToken })).rejects.toThrow(
      'прострочено',
    );
    expect(runMountedWorkerProbe).not.toHaveBeenCalled();
  });
});
