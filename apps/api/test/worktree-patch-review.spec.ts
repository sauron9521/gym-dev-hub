import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreePlan } from '@gym-dev-hub/contracts';
import { WorktreeIntegrityService } from '../src/worktree/worktree-integrity.service.js';
import { WorktreePatchReviewService } from '../src/worktree/worktree-patch-review.service.js';

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN_ID = '00000000-0000-4000-8000-000000000123';
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const SECRET = 'patch-review-test-independent-secret-abcdefghijklmnopqrstuvwxyz';
const PATH = 'src/main.ts';
const BEFORE = 'one\ntwo\nthree\n';
const AFTER = 'one\nTWO\nthree\n';
const OTHER = 'export const other = true;\n';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000 }).trim();

describe('read-only post-apply verification of one Git worktree file', () => {
  let base: string;
  let source: string;
  let target: string;
  let state: string;
  let grantId: string;
  let plan: WorktreePlan;
  let integrity: WorktreeIntegrityService;
  let review: WorktreePatchReviewService;
  let plans: { list: ReturnType<typeof vi.fn>; availableForMountProbe: ReturnType<typeof vi.fn> };
  let inspection: { inspect: ReturnType<typeof vi.fn> };

  const input = () => ({
    grantId,
    fingerprint: FINGERPRINT,
    sourceCommit: plan.baseHeadSha!,
    filePath: PATH,
    sourceSha256: sha(BEFORE),
    proposedSha256: sha(AFTER),
    operatorSecret: SECRET,
  });

  async function audit(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    const record =
      JSON.stringify({
        at: new Date().toISOString(),
        event,
        grantId,
        sessionId: SESSION,
        planId: PLAN_ID,
        sourceCommit: plan.baseHeadSha,
        fingerprint: FINGERPRINT,
        filePathSha256: sha(PATH),
        sourceSha256: sha(BEFORE),
        patchSha256: sha('approved-diff'),
        proposedSha256: sha(AFTER),
        ...fields,
      }) + '\n';
    const path = join(state, 'audit.jsonl');
    const old = await readFile(path, 'utf8').catch(() => '');
    await writeFile(path, old + record, { mode: 0o600 });
    await chmod(path, 0o600);
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    base = await mkdtemp(join(tmpdir(), 'devhub-review-'));
    source = join(base, 'source');
    target = join(base, 'worktree');
    state = join(base, 'private');
    grantId = randomUUID();
    await mkdir(join(source, 'src'), { recursive: true });
    await mkdir(state, { mode: 0o700 });
    await writeFile(join(source, PATH), BEFORE);
    await writeFile(join(source, 'src/other.ts'), OTHER);
    git(base, ['init', '-q', 'source']);
    git(source, ['add', '--', 'src/main.ts', 'src/other.ts']);
    git(source, [
      '-c',
      'user.name=Dev Hub Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-q',
      '-m',
      'fixture',
    ]);
    const commit = git(source, ['rev-parse', 'HEAD']);
    git(source, ['worktree', 'add', '-q', '-b', 'devhub/task-review-fixture', target, commit]);
    await writeFile(join(target, PATH), AFTER);
    await chmod(join(target, PATH), 0o644);

    plan = {
      id: PLAN_ID,
      sessionId: SESSION,
      repository: 'sauron9521/gym-dev-hub',
      sourcePath: source,
      targetPath: target,
      proposedBranch: 'devhub/task-review-fixture',
      fingerprint: FINGERPRINT,
      state: 'created',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      history: [],
      executionEnabled: false,
      worktreeCreated: true,
      hydrationState: 'completed',
      hydrationFiles: 2,
      hydrationBytes: Buffer.byteLength(BEFORE) + Buffer.byteLength(OTHER),
      baseHeadSha: commit,
    };
    plans = {
      list: vi.fn().mockImplementation(async () => [plan]),
      availableForMountProbe: vi.fn().mockImplementation(async () => plan),
    };
    inspection = {
      inspect: vi.fn().mockResolvedValue({
        targetExists: true,
        findings: ['У worktree вже є файли: потрібна ручна перевірка.'],
      }),
    };
    integrity = new WorktreeIntegrityService(plans as never, inspection as never);
    review = new WorktreePatchReviewService(plans as never, integrity);
    process.env.DEV_HUB_PATCH_APPLY_STATE_DIR = state;
    process.env.DEV_HUB_ENABLE_PATCH_REVIEW = 'true';
    process.env.DEV_HUB_PATCH_APPLY_OPERATOR_SECRET = SECRET;
    await audit('issued');
    await audit('attempted');
    await audit('applied');
  });

  afterEach(async () => {
    delete process.env.DEV_HUB_PATCH_APPLY_STATE_DIR;
    delete process.env.DEV_HUB_ENABLE_PATCH_REVIEW;
    delete process.env.DEV_HUB_PATCH_APPLY_OPERATOR_SECRET;
    await rm(base, { recursive: true, force: true });
  });

  it('verifies one approved changed file and every unchanged Git blob, returns actual diff and manual test plan', async () => {
    expect((await integrity.verify(SESSION, PLAN_ID)).status).toBe('mismatch');
    const result = await review.review(SESSION, PLAN_ID, input());
    expect(result).toMatchObject({
      grantId,
      sessionId: SESSION,
      planId: PLAN_ID,
      sourceCommit: plan.baseHeadSha,
      filePath: PATH,
      sourceSha256: sha(BEFORE),
      proposedSha256: sha(AFTER),
      status: 'verified',
      changedFiles: 1,
      trackedFiles: 2,
      readOnly: true,
      testsExecuted: false,
      commitCreated: false,
      pushEnabled: false,
      mergeEnabled: false,
    });
    expect(result.diff).toContain('diff --git a/src/main.ts b/src/main.ts');
    expect(result.diff).toContain('-two');
    expect(result.diff).toContain('+TWO');
    expect(result.recommendedChecks).toEqual(['pnpm check']);
    expect(await readFile(join(target, PATH), 'utf8')).toBe(AFTER);
    expect(await readdir(join(target, 'src'))).toEqual(['main.ts', 'other.ts']);
    expect(git(target, ['status', '--porcelain'])).toContain('M src/main.ts');
  });

  it('recovers a consumed one-file patch from the private audit with zero writes', async () => {
    const auditBefore = await readFile(join(state, 'audit.jsonl'));
    const sourceBefore = await readFile(join(source, PATH));
    const targetBefore = await readFile(join(target, PATH));
    const result = await review.recover(SESSION, PLAN_ID, { operatorSecret: SECRET });
    expect(result).toMatchObject({
      applied: {
        sessionId: SESSION,
        planId: PLAN_ID,
        grantId,
        sourceCommit: plan.baseHeadSha,
        filePath: PATH,
        sourceSha256: sha(BEFORE),
        proposedSha256: sha(AFTER),
        status: 'applied',
        mergeEnabled: false,
        githubPushEnabled: false,
      },
      verified: {
        status: 'verified',
        changedFiles: 1,
        grantId,
        readOnly: true,
        commitCreated: false,
        pushEnabled: false,
        mergeEnabled: false,
      },
      readOnly: true,
      grantIssued: false,
      writesPerformed: false,
    });
    expect(result.verified.diff).toContain('+TWO');
    expect(await readFile(join(state, 'audit.jsonl'))).toEqual(auditBefore);
    expect(await readFile(join(source, PATH))).toEqual(sourceBefore);
    expect(await readFile(join(target, PATH))).toEqual(targetBefore);
  });

  it('denies recovery with wrong secret or ambiguous audit chain', async () => {
    await expect(
      review.recover(SESSION, PLAN_ID, { operatorSecret: 'a'.repeat(40) }),
    ).rejects.toThrow('Невірний секрет');
    await audit('applied');
    await expect(review.recover(SESSION, PLAN_ID, { operatorSecret: SECRET })).rejects.toThrow(
      'Немає єдиного застосованого патча',
    );
  });

  it('fails closed on an additional modified file without replaying the patch', async () => {
    await writeFile(join(target, 'src/other.ts'), 'foreign change\\n');
    await expect(review.recover(SESSION, PLAN_ID, { operatorSecret: SECRET })).rejects.toThrow(
      'Неможливо відновити єдиний Git diff',
    );
  });

  it('rejects unknown, forged, mixed or post-failure audit receipts', async () => {
    await expect(
      review.review(SESSION, PLAN_ID, { ...input(), grantId: randomUUID() }),
    ).rejects.toThrow('успішного запису');
    await expect(
      review.review(SESSION, PLAN_ID, { ...input(), proposedSha256: 'f'.repeat(64) }),
    ).rejects.toThrow('успішного запису');
    await audit('rejected');
    await expect(review.review(SESSION, PLAN_ID, input())).rejects.toThrow('успішного запису');
  });

  it('rejects second modified tracked file, extra file and extra directory', async () => {
    await writeFile(join(target, 'src/other.ts'), 'extra\n');
    await expect(review.review(SESSION, PLAN_ID, input())).rejects.toThrow('Знайдено інші зміни');
    await writeFile(join(target, 'src/other.ts'), OTHER);
    await writeFile(join(target, 'src/untracked.ts'), 'unexpected\n');
    await expect(review.review(SESSION, PLAN_ID, input())).rejects.toThrow('Знайдено інші зміни');
    await rm(join(target, 'src/untracked.ts'));
    await mkdir(join(target, 'extra-dir'));
    await expect(review.review(SESSION, PLAN_ID, input())).rejects.toThrow('Знайдено інші зміни');
  });

  it('rejects a tampered postimage and does not return a diff', async () => {
    await writeFile(join(target, PATH), 'one\nwrong\nthree\n');
    await expect(review.review(SESSION, PLAN_ID, input())).rejects.toThrow('Знайдено інші зміни');
  });

  it('rejects an invalid preimage Git SHA and tampered HEAD', async () => {
    await expect(
      review.review(SESSION, PLAN_ID, {
        ...input(),
        sourceSha256: 'f'.repeat(64),
      }),
    ).rejects.toThrow('успішного запису');
    git(target, ['reset', '-q', '--hard', 'HEAD']);
    git(target, [
      '-c',
      'user.name=Dev Hub Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'unexpected',
    ]);
    await writeFile(join(target, PATH), AFTER);
    await expect(review.review(SESSION, PLAN_ID, input())).rejects.toThrow();
  });

  it('rejects symlinks to protected paths', async () => {
    await rm(join(target, PATH));
    await symlink(join(source, PATH), join(target, PATH));
    await expect(review.review(SESSION, PLAN_ID, input())).rejects.toThrow('Знайдено інші зміни');
    expect(await readFile(join(source, PATH), 'utf8')).toBe(BEFORE);
  });

  it('requires an independent operator secret and explicit opt-in', async () => {
    delete process.env.DEV_HUB_ENABLE_PATCH_REVIEW;
    await expect(review.review(SESSION, PLAN_ID, input())).rejects.toThrow('вимкнений');
    process.env.DEV_HUB_ENABLE_PATCH_REVIEW = 'true';
    await expect(
      review.review(SESSION, PLAN_ID, {
        ...input(),
        operatorSecret: 'z'.repeat(40),
      }),
    ).rejects.toThrow('секрет');
  });

  it('refuses a leftover writer lock without removing it', async () => {
    const path = join(state, PLAN_ID + '.lock');
    await writeFile(path, 'review needed');
    await expect(review.review(SESSION, PLAN_ID, input())).rejects.toThrow('lock');
    expect(await readFile(path, 'utf8')).toBe('review needed');
  });

  it('rejects missing audit and symlinked audit logs', async () => {
    const file = join(state, 'audit.jsonl');
    const copy = join(base, 'copy.txt');
    await writeFile(copy, await readFile(file));
    await rm(file);
    await expect(review.review(SESSION, PLAN_ID, input())).rejects.toThrow('audit');
    await symlink(copy, file);
    await expect(review.review(SESSION, PLAN_ID, input())).rejects.toThrow('audit');
  });

  it('rejects request body extra fields and wrong session', async () => {
    await expect(review.review(SESSION, PLAN_ID, { ...input(), runShell: true })).rejects.toThrow(
      'параметри',
    );
    await expect(
      review.review('00000000-0000-4000-8000-000000000457', PLAN_ID, input()),
    ).rejects.toThrow('успішного запису');
  });

  it('never executes recommended commands or changes the tracked index', async () => {
    const before = git(target, ['status', '--porcelain']);
    const answer = await review.review(SESSION, PLAN_ID, input());
    expect(answer.testsExecuted).toBe(false);
    expect(answer.commitCreated).toBe(false);
    expect(git(target, ['status', '--porcelain'])).toBe(before);
  });
});
