import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeIntegrityReport, WorktreePlan } from '@gym-dev-hub/contracts';
import { WorktreePatchApplyService } from '../src/worktree/worktree-patch-apply.service.js';
import { WorktreePatchPreflightService } from '../src/worktree/worktree-patch-preflight.service.js';

const SECRET = 'really-long-separate-secret-for-patch-write-without-openai-keys';
const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const COMMIT = 'a'.repeat(40);
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const PATH = 'src/main.ts';
const CONTENT = 'one\ntwo\nthree\n';
const PATCH = `--- a/${PATH}\n+++ b/${PATH}\n@@ -2 +2 @@\n-two\n+TWO`;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

describe('single-use, opt-in, file-scoped patch write', () => {
  let base: string;
  let root: string;
  let state: string;
  let service: WorktreePatchApplyService;
  let plans: { availableForMountProbe: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
  let integrity: { verify: ReturnType<typeof vi.fn> };
  let plan: WorktreePlan;
  let report: WorktreeIntegrityReport;

  const proposal = () => ({
    fingerprint: FINGERPRINT,
    sourceCommit: COMMIT,
    filePath: PATH,
    expectedSourceSha256: hash(CONTENT),
    patch: PATCH,
  });
  const approve = () => ({
    ...proposal(),
    confirmation: 'I_APPROVE_ONE_FILE_PATCH_ONLY',
    operatorSecret: SECRET,
  });
  const execute = (token: string) => ({
    ...proposal(),
    grantToken: token,
    operatorSecret: SECRET,
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    base = await mkdtemp(join(tmpdir(), 'devhub-apply-test-'));
    root = join(base, 'worktree');
    state = join(base, 'private');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, PATH), CONTENT, { mode: 0o600 });
    await chmod(join(root, PATH), 0o600);
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
      checkedAt: new Date().toISOString(),
      fileCount: 1,
      verifiedBytes: Buffer.byteLength(CONTENT),
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
    plans = {
      availableForMountProbe: vi.fn().mockImplementation(async () => plan),
      list: vi.fn().mockImplementation(async () => [plan]),
    };
    integrity = { verify: vi.fn().mockImplementation(async () => report) };
    const preflight = new WorktreePatchPreflightService(plans as never, integrity as never);
    service = new WorktreePatchApplyService(plans as never, preflight);
    process.env.DEV_HUB_ENABLE_PATCH_APPLY = 'true';
    process.env.DEV_HUB_PATCH_APPLY_OPERATOR_SECRET = SECRET;
    process.env.DEV_HUB_ENABLE_PATCH_PREFLIGHT = 'true';
    process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ = 'true';
    process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT = 'true';
    process.env.DEV_HUB_PATCH_APPLY_STATE_DIR = state;
  });

  afterEach(async () => {
    for (const key of [
      'DEV_HUB_ENABLE_PATCH_APPLY',
      'DEV_HUB_PATCH_APPLY_OPERATOR_SECRET',
      'DEV_HUB_ENABLE_PATCH_PREFLIGHT',
      'DEV_HUB_ENABLE_SCOPED_CODE_READ',
      'DEV_HUB_ENABLE_WORKTREE_MOUNT',
      'DEV_HUB_PATCH_APPLY_STATE_DIR',
    ])
      delete process.env[key];
    await rm(base, { recursive: true, force: true });
  });

  it('authorizes then atomically replaces exactly one file; audits without secrets or diff', async () => {
    const grant = await service.authorize(SESSION, PLAN, approve());
    expect(grant).toMatchObject({
      filePath: PATH,
      sourceCommit: COMMIT,
      purpose: 'WRITE_ONE_APPROVED_WORKTREE_FILE',
      patchSha256: hash(PATCH),
      proposedSha256: hash('one\nTWO\nthree\n'),
    });
    expect(grant.grantToken).toHaveLength(43);
    expect(grant.grantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(join(root, PATH), 'utf8')).toBe(CONTENT);

    const output = await service.apply(SESSION, PLAN, execute(grant.grantToken));
    expect(output).toMatchObject({
      status: 'applied',
      sourceCommit: COMMIT,
      sourceSha256: hash(CONTENT),
      proposedSha256: hash('one\nTWO\nthree\n'),
      grantId: grant.grantId,
      mergeEnabled: false,
      githubPushEnabled: false,
    });
    expect(await readFile(join(root, PATH), 'utf8')).toBe('one\nTWO\nthree\n');
    expect((await lstat(join(root, PATH))).mode & 0o777).toBe(0o600);
    expect(await readdir(join(root, 'src'))).toEqual(['main.ts']);
    expect(await readdir(state)).toEqual(['audit.jsonl']);
    const audit = await readFile(join(state, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"event":"issued"');
    expect(audit).toContain('"event":"attempted"');
    expect(audit).toContain('"event":"applied"');
    expect(audit).not.toContain(grant.grantToken);
    expect(audit).not.toContain(SECRET);
    expect(audit).not.toContain(PATCH);
    expect(audit).not.toContain(root);
    expect(integrity.verify).toHaveBeenCalledTimes(4);
  });

  it('does not write when opt-in disabled or write secret invalid', async () => {
    delete process.env.DEV_HUB_ENABLE_PATCH_APPLY;
    await expect(service.authorize(SESSION, PLAN, approve())).rejects.toThrow('вимкнене');
    process.env.DEV_HUB_ENABLE_PATCH_APPLY = 'true';
    delete process.env.DEV_HUB_PATCH_APPLY_OPERATOR_SECRET;
    await expect(service.authorize(SESSION, PLAN, approve())).rejects.toThrow('секрет');
    process.env.DEV_HUB_PATCH_APPLY_OPERATOR_SECRET = SECRET;
    await expect(
      service.authorize(SESSION, PLAN, { ...approve(), operatorSecret: 'z'.repeat(40) }),
    ).rejects.toThrow('секрет');
    expect(await readFile(join(root, PATH), 'utf8')).toBe(CONTENT);
  });

  it('requires explicit confirmation and refuses untrusted extra arguments', async () => {
    await expect(
      service.authorize(SESSION, PLAN, { ...proposal(), operatorSecret: SECRET }),
    ).rejects.toThrow('дозвіл');
    await expect(
      service.authorize(SESSION, PLAN, { ...approve(), runShell: true }),
    ).rejects.toThrow('дозвіл');
    await expect(
      service.apply(SESSION, PLAN, { ...execute('A'.repeat(43)), argv: ['rm', '-rf'] }),
    ).rejects.toThrow('Некоректний');
  });

  it('consumes the token once and rejects replay or another session', async () => {
    const grant = await service.authorize(SESSION, PLAN, approve());
    await service.apply(SESSION, PLAN, execute(grant.grantToken));
    await expect(service.apply(SESSION, PLAN, execute(grant.grantToken))).rejects.toThrow(
      'використаний',
    );
    const other = await service
      .authorize(SESSION, PLAN, {
        ...approve(),
        expectedSourceSha256: hash('one\nTWO\nthree\n'),
        patch: PATCH,
      })
      .catch(() => null);
    // The completed write makes a second grant against pinned Git impossible.
    expect(other).toBeNull();
    expect(await readFile(join(root, PATH), 'utf8')).toBe('one\nTWO\nthree\n');
  });

  it('rejects cross-session or altered patch and permanently consumes grant', async () => {
    const g = await service.authorize(SESSION, PLAN, approve());
    await expect(
      service.apply('00000000-0000-4000-8000-000000000457', PLAN, execute(g.grantToken)),
    ).rejects.toThrow('недійсний');
    await expect(service.apply(SESSION, PLAN, execute(g.grantToken))).rejects.toThrow(
      'використаний',
    );
    const g2 = await service.authorize(SESSION, PLAN, approve());
    await expect(
      service.apply(SESSION, PLAN, { ...execute(g2.grantToken), patch: PATCH + '\n' }),
    ).rejects.toThrow('недійсний');
    expect(await readFile(join(root, PATH), 'utf8')).toBe(CONTENT);
  });

  it('rejects drift between authorization and apply without writing', async () => {
    const g = await service.authorize(SESSION, PLAN, approve());
    await writeFile(join(root, PATH), 'tampered\n');
    await expect(service.apply(SESSION, PLAN, execute(g.grantToken))).rejects.toThrow('змінився');
    expect(await readFile(join(root, PATH), 'utf8')).toBe('tampered\n');
    const audit = await readFile(join(state, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"event":"rejected"');
    expect(await readdir(state)).toEqual(['audit.jsonl']);
  });

  it('rejects a symlink in place of the file before any write', async () => {
    const g = await service.authorize(SESSION, PLAN, approve());
    await rm(join(root, PATH));
    const replacement = join(base, 'private-file.txt');
    await writeFile(replacement, CONTENT);
    await symlink(replacement, join(root, PATH));
    await expect(service.apply(SESSION, PLAN, execute(g.grantToken))).rejects.toThrow('Git-файла');
    expect(await readFile(replacement, 'utf8')).toBe(CONTENT);
  });

  it('rejects hardlinked targets, even when the bytes are correct', async () => {
    const g = await service.authorize(SESSION, PLAN, approve());
    const other = join(base, 'hardlink');
    await link(join(root, PATH), other);
    await expect(service.apply(SESSION, PLAN, execute(g.grantToken))).rejects.toThrow(
      'потребує ручної перевірки',
    );
    expect(await readFile(other, 'utf8')).toBe(CONTENT);
  });

  it('rejects an unsupported permission mode before rename', async () => {
    const g = await service.authorize(SESSION, PLAN, approve());
    await chmod(join(root, PATH), 0o755);
    await expect(service.apply(SESSION, PLAN, execute(g.grantToken))).rejects.toThrow(
      'потребує ручної перевірки',
    );
    expect(await readFile(join(root, PATH), 'utf8')).toBe(CONTENT);
  });

  it('fails closed on an existing cross-process lock without removing it', async () => {
    const g = await service.authorize(SESSION, PLAN, approve());
    await writeFile(join(state, PLAN + '.lock'), 'other worker');
    await expect(service.apply(SESSION, PLAN, execute(g.grantToken))).rejects.toThrow('зайнятий');
    expect(await readFile(join(state, PLAN + '.lock'), 'utf8')).toBe('other worker');
    expect(await readFile(join(root, PATH), 'utf8')).toBe(CONTENT);
  });

  it('fails closed when audit storage is a symlink without producing a grant', async () => {
    await mkdir(state, { recursive: true, mode: 0o700 });
    const outside = join(base, 'outside.txt');
    await writeFile(outside, 'other');
    await symlink(outside, join(state, 'audit.jsonl'));
    await expect(service.authorize(SESSION, PLAN, approve())).rejects.toThrow('аудиту');
    expect(await readFile(outside, 'utf8')).toBe('other');
  });

  it('rejects an expired grant before filesystem writes', async () => {
    const g = await service.authorize(SESSION, PLAN, approve());
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 46_000);
      await expect(service.apply(SESSION, PLAN, execute(g.grantToken))).rejects.toThrow(
        'прострочений',
      );
      expect(await readFile(join(root, PATH), 'utf8')).toBe(CONTENT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('revalidates snapshot on execution and rejects a stale or changed Git plan', async () => {
    const g = await service.authorize(SESSION, PLAN, approve());
    plan.baseHeadSha = 'c'.repeat(40);
    await expect(service.apply(SESSION, PLAN, execute(g.grantToken))).rejects.toThrow('commit');
    expect(await readFile(join(root, PATH), 'utf8')).toBe(CONTENT);
  });
});
