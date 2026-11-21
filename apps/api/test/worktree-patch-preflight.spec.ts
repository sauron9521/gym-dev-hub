import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeIntegrityReport, WorktreePlan } from '@gym-dev-hub/contracts';
import { WorktreePatchPreflightService } from '../src/worktree/worktree-patch-preflight.service.js';

const SECRET = 'dev-hub-local-read-only-preflight-operator-secret-123456';
const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const COMMIT = 'a'.repeat(40);
const ORIGINAL = 'one\ntwo\nthree\n';
const PATCH = '--- a/src/main.ts\n+++ b/src/main.ts\n@@ -2 +2 @@\n-two\n+TWO';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

describe('read-only server patch preflight', () => {
  let root: string;
  let service: WorktreePatchPreflightService;
  let plan: WorktreePlan;
  let plans: { availableForMountProbe: ReturnType<typeof vi.fn> };
  let integrity: { verify: ReturnType<typeof vi.fn> };
  let report: WorktreeIntegrityReport;

  const input = () => ({
    fingerprint: FINGERPRINT,
    sourceCommit: COMMIT,
    filePath: 'src/main.ts',
    expectedSourceSha256: hash(ORIGINAL),
    patch: PATCH,
    operatorSecret: SECRET,
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(join(tmpdir(), 'devhub-patch-preflight-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'main.ts'), ORIGINAL);
    plan = {
      id: PLAN,
      sessionId: SESSION,
      repository: 'sauron9521/gym-platform',
      sourcePath: root,
      targetPath: root,
      proposedBranch: 'devhub/task-test',
      fingerprint: FINGERPRINT,
      state: 'created',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      history: [],
      executionEnabled: false,
      worktreeCreated: true,
      hydrationState: 'completed',
      baseHeadSha: COMMIT,
    };
    report = {
      planId: PLAN,
      sessionId: SESSION,
      status: 'verified',
      fileCount: 1,
      verifiedBytes: Buffer.byteLength(ORIGINAL),
      findings: [],
      checkedAt: new Date().toISOString(),
      mount: {
        sourcePath: root,
        targetPath: '/workspace',
        readOnly: true,
        networkEnabled: false,
        mountEnabled: false,
        executionEnabled: false,
      },
    };
    plans = { availableForMountProbe: vi.fn().mockResolvedValue(plan) };
    integrity = { verify: vi.fn().mockResolvedValue(report) };
    service = new WorktreePatchPreflightService(plans as never, integrity as never);
    process.env.DEV_HUB_ENABLE_PATCH_PREFLIGHT = 'true';
    process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ = 'true';
    process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT = 'true';
    process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET = SECRET;
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
    delete process.env.DEV_HUB_ENABLE_PATCH_PREFLIGHT;
    delete process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ;
    delete process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT;
    delete process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET;
  });

  it('reports pinned SHA hashes only, with no file mutation or grant', async () => {
    const result = await service.preview(SESSION, PLAN, input());
    expect(result).toMatchObject({
      sessionId: SESSION,
      planId: PLAN,
      filePath: 'src/main.ts',
      sourceCommit: COMMIT,
      fingerprint: FINGERPRINT,
      sourceSha256: hash(ORIGINAL),
      patchSha256: hash(PATCH),
      proposedSha256: hash('one\nTWO\nthree\n'),
      added: 1,
      removed: 1,
      integrity: 'verified',
      writeEnabled: false,
      authorizationGranted: false,
      readOnly: true,
    });
    expect(JSON.stringify(result)).not.toContain('one');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe(ORIGINAL);
    expect(plans.availableForMountProbe).toHaveBeenCalledWith(SESSION, PLAN);
    expect(integrity.verify).toHaveBeenCalledTimes(2);
  });

  it('defaults to disabled and requires strong configured secret and read gates', async () => {
    delete process.env.DEV_HUB_ENABLE_PATCH_PREFLIGHT;
    await expect(service.preview(SESSION, PLAN, input())).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_PATCH_PREFLIGHT = 'true';
    delete process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ;
    await expect(service.preview(SESSION, PLAN, input())).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ = 'true';
    delete process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT;
    await expect(service.preview(SESSION, PLAN, input())).rejects.toThrow('вимкнено');
    process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT = 'true';
    process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET = 'short';
    await expect(service.preview(SESSION, PLAN, input())).rejects.toThrow('секрет');
  });

  it('rejects wrong operator secret before reading worktree', async () => {
    await expect(
      service.preview(SESSION, PLAN, { ...input(), operatorSecret: 'z'.repeat(40) }),
    ).rejects.toThrow('секрет');
    expect(integrity.verify).not.toHaveBeenCalled();
  });

  it('rejects wrong commit, fingerprint, source hash and changed file', async () => {
    await expect(
      service.preview(SESSION, PLAN, { ...input(), sourceCommit: 'f'.repeat(40) }),
    ).rejects.toThrow('commit');
    await expect(
      service.preview(SESSION, PLAN, { ...input(), fingerprint: 'sha256:' + 'c'.repeat(64) }),
    ).rejects.toThrow('fingerprint');
    await expect(
      service.preview(SESSION, PLAN, { ...input(), expectedSourceSha256: 'c'.repeat(64) }),
    ).rejects.toThrow('змінився');
    await writeFile(join(root, 'src', 'main.ts'), 'tampered\n');
    await expect(service.preview(SESSION, PLAN, input())).rejects.toThrow('змінився');
  });

  it('rejects malicious patch, unknown file and unsupported path', async () => {
    await expect(
      service.preview(SESSION, PLAN, { ...input(), patch: PATCH.replace('-two', '-forged') }),
    ).rejects.toThrow('Патч');
    await expect(
      service.preview(SESSION, PLAN, { ...input(), filePath: '../.env' }),
    ).rejects.toThrow('шлях');
    await expect(
      service.preview(SESSION, PLAN, { ...input(), filePath: 'src/secret.ts' }),
    ).rejects.toThrow('Git-файла');
    await expect(
      service.preview(SESSION, PLAN, { ...input(), patch: 'x'.repeat(20_001) }),
    ).rejects.toThrow('параметри');
  });

  it('rejects symlink and a file that exceeds the bounded size', async () => {
    await symlink(join(root, 'src', 'main.ts'), join(root, 'src', 'link.ts'));
    await expect(
      service.preview(SESSION, PLAN, { ...input(), filePath: 'src/link.ts' }),
    ).rejects.toThrow('Git-файла');
    await writeFile(join(root, 'src', 'main.ts'), 'x'.repeat(8_193));
    await expect(service.preview(SESSION, PLAN, input())).rejects.toThrow('Git-файла');
  });

  it('rejects Git drift before and after the read, without granting write access', async () => {
    integrity.verify.mockResolvedValueOnce({ ...report, status: 'mismatch' });
    await expect(service.preview(SESSION, PLAN, input())).rejects.toThrow('Git');
    integrity.verify.mockReset();
    integrity.verify.mockResolvedValueOnce(report).mockResolvedValueOnce({
      ...report,
      status: 'mismatch',
    });
    await expect(service.preview(SESSION, PLAN, input())).rejects.toThrow('Git');
    expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe(ORIGINAL);
  });

  it('fails closed on unsupported mounts and unknown or completed plans', async () => {
    integrity.verify.mockResolvedValue({
      ...report,
      mount: { ...report.mount, mountEnabled: true },
    });
    await expect(service.preview(SESSION, PLAN, input())).rejects.toThrow('Git');
    plans.availableForMountProbe.mockRejectedValueOnce(new Error('Completed session'));
    await expect(service.preview(SESSION, PLAN, input())).rejects.toThrow('Completed');
  });

  it('rejects an unknown extra field in the request body', async () => {
    await expect(service.preview(SESSION, PLAN, { ...input(), execute: true })).rejects.toThrow(
      'параметри',
    );
  });

  it('allows no concurrent preflight checks in one process', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    integrity.verify.mockImplementationOnce(async () => {
      await pending;
      return report;
    });
    const first = service.preview(SESSION, PLAN, input());
    // Yield to the first async integrity verification.
    await vi.waitFor(() => expect(integrity.verify).toHaveBeenCalledOnce());
    await expect(service.preview(SESSION, PLAN, input())).rejects.toThrow('ще виконується');
    release();
    await expect(first).resolves.toMatchObject({ writeEnabled: false });
  });
});
