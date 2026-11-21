import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  MAX_PATCH_CHARS,
  reviewCodexPatch,
  type WorktreeCodeReadResult,
  type WorktreePatchApplyGrant,
  type WorktreePatchApplyResult,
  type WorktreePatchPreflightResult,
} from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreePatchPreflightService } from './worktree-patch-preflight.service.js';
import { validateScopedCodePath } from './worktree-mount-probe.js';

const MAX_GRANTS = 16;
const MAX_SOURCE = 8_192;
const MAX_OUTPUT = 12_288;
const AUDIT_MAX = 1024 * 1024;
const TTL_MS = 45_000;
const proposalSchema = z.strictObject({
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  filePath: z.string().min(1).max(160),
  expectedSourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  patch: z.string().min(1).max(MAX_PATCH_CHARS),
});
const approveSchema = proposalSchema.extend({
  confirmation: z.literal('I_APPROVE_ONE_FILE_PATCH_ONLY'),
  operatorSecret: z.string().min(32).max(256),
});
const executeSchema = proposalSchema.extend({
  grantToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  operatorSecret: z.string().min(32).max(256),
});
type Proposal = z.infer<typeof proposalSchema>;
type Grant = {
  id: string;
  sessionId: string;
  planId: string;
  expiresAt: number;
  fingerprint: string;
  sourceCommit: string;
  filePath: string;
  expectedSourceSha256: string;
  patchSha256: string;
  proposedSha256: string;
};
type AuditEvent = 'issued' | 'attempted' | 'applied' | 'rejected';
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

async function privateStateDir(): Promise<string> {
  const root = resolve(
    process.env.DEV_HUB_PATCH_APPLY_STATE_DIR ?? resolve(process.cwd(), '.local', 'patch-apply'),
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const [stat, canonical] = await Promise.all([lstat(root), realpath(root)]);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical !== root ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error('Unsafe private patch state directory');
  }
  return root;
}

/** Mandatory durable audit. Never writes credentials, source, diff or local paths. */
async function audit(grant: Grant, event: AuditEvent): Promise<void> {
  const file = join(await privateStateDir(), 'audit.jsonl');
  const before = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) {
    throw new Error('Unsafe audit log');
  }
  const fd = await open(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size >= AUDIT_MAX ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error('Unsafe audit log metadata');
    }
    const record = JSON.stringify({
      at: new Date().toISOString(),
      event,
      grantId: grant.id,
      sessionId: grant.sessionId,
      planId: grant.planId,
      sourceCommit: grant.sourceCommit,
      fingerprint: grant.fingerprint,
      filePathSha256: sha(grant.filePath),
      sourceSha256: grant.expectedSourceSha256,
      patchSha256: grant.patchSha256,
      proposedSha256: grant.proposedSha256,
    });
    if (Buffer.byteLength(record) > 1000) throw new Error('Audit record too large');
    await fd.writeFile(record + '\n');
    await fd.sync();
  } finally {
    await fd.close();
  }
}

/**
 * Prepare an exclusive, pinned single-file replacement. The final rename is
 * atomic on one filesystem. Path/FD identity is checked immediately before it,
 * but no Node.js filesystem API can prevent a hostile local process from
 * changing ancestor paths between checks. Local trusted-user workflow only.
 */
async function replaceOneFile(
  sourcePath: string,
  filePath: string,
  beforeSha: string,
  proposedContent: string,
): Promise<void> {
  validateScopedCodePath(filePath);
  const root = await realpath(sourcePath);
  if (root !== resolve(sourcePath)) throw new Error('Noncanonical worktree source');
  const parts = filePath.split('/');
  let path = root;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) {
      throw new Error('Unsafe path component');
    }
  }
  const target = path;
  const parent = dirname(target);
  const realParent = await realpath(parent);
  if (!(realParent === root || realParent.startsWith(root + sep))) {
    throw new Error('Path outside worktree');
  }
  if ((await realpath(target)) !== target) throw new Error('Source path changed');
  const data = Buffer.from(proposedContent, 'utf8');
  if (data.length > MAX_OUTPUT) throw new Error('Proposed file too large');

  let temp: string | null = null;
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const mode = before.mode & 0o777;
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      ![0o600, 0o644].includes(mode) ||
      before.size > MAX_SOURCE
    ) {
      throw new Error('Unsupported file type or permissions');
    }
    const original = await handle.readFile();
    if (original.length !== before.size || sha(original) !== beforeSha) {
      throw new Error('Original file does not match approved SHA');
    }
    const candidate = join(parent, '.devhub-patch-' + randomUUID());
    const staging = await open(
      candidate,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    // Only remove a temporary file we successfully created with O_EXCL.
    temp = candidate;
    try {
      await staging.writeFile(data);
      await staging.chmod(mode);
      await staging.sync();
    } finally {
      await staging.close();
    }
    // Last point-of-use check, after writing/fsyncing the temporary replacement.
    const [last, lastHandle] = await Promise.all([
      lstat(target),
      open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
    ]);
    try {
      const descriptor = await lastHandle.stat();
      if (
        !last.isFile() ||
        last.isSymbolicLink() ||
        last.nlink !== 1 ||
        last.ino !== before.ino ||
        last.dev !== before.dev ||
        last.size !== before.size ||
        last.mtimeMs !== before.mtimeMs ||
        last.ctimeMs !== before.ctimeMs ||
        last.mode !== before.mode ||
        descriptor.ino !== before.ino ||
        descriptor.dev !== before.dev ||
        descriptor.size !== before.size ||
        descriptor.mtimeMs !== before.mtimeMs ||
        descriptor.ctimeMs !== before.ctimeMs ||
        descriptor.mode !== before.mode
      ) {
        throw new Error('Target changed before atomic replacement');
      }
      const lastBytes = await lastHandle.readFile();
      if (sha(lastBytes) !== beforeSha) throw new Error('Source bytes changed');
    } finally {
      await lastHandle.close();
    }
    if ((await realpath(parent)) !== realParent) throw new Error('Parent path changed');
    await rename(temp, target);
    temp = null;
    const observed = await readFile(target);
    if (sha(observed) !== sha(data))
      throw new Error('Post-write SHA mismatch; manual review needed');
  } finally {
    await handle.close();
    if (temp)
      await unlink(temp).catch(() => {
        // Fail closed: a partially staged file needs manual inspection.
      });
  }
}

@Injectable()
export class WorktreePatchApplyService {
  private readonly grants = new Map<string, Grant>();
  private secretDigest: Buffer | null = null;
  private readonly activePlans = new Set<string>();

  constructor(
    private readonly plans: WorktreePlanService,
    private readonly preflight: WorktreePatchPreflightService,
  ) {}

  private authenticate(value: string): void {
    if (process.env.DEV_HUB_ENABLE_PATCH_APPLY !== 'true') {
      this.grants.clear();
      throw new ServiceUnavailableException('Застосування патчів вимкнене.');
    }
    const configured = process.env.DEV_HUB_PATCH_APPLY_OPERATOR_SECRET;
    if (!configured || Buffer.byteLength(configured) < 32 || Buffer.byteLength(configured) > 256) {
      this.grants.clear();
      throw new ServiceUnavailableException('Потрібен окремий секрет для запису патча.');
    }
    const expected = createHash('sha256').update(configured).digest();
    if (this.secretDigest && !timingSafeEqual(this.secretDigest, expected)) this.grants.clear();
    this.secretDigest = expected;
    if (!timingSafeEqual(expected, createHash('sha256').update(value).digest())) {
      throw new ForbiddenException('Неправильний секрет застосування патча.');
    }
  }

  private async verifiedProposal(
    sessionId: string,
    planId: string,
    proposal: Proposal,
  ): Promise<WorktreePatchPreflightResult> {
    try {
      validateScopedCodePath(proposal.filePath);
    } catch {
      throw new BadRequestException('Недозволений шлях файла.');
    }
    return this.preflight.revalidateForWrite(sessionId, planId, proposal);
  }

  async authorize(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreePatchApplyGrant> {
    const input = approveSchema.safeParse(body);
    if (!input.success) throw new BadRequestException('Некоректний дозвіл на один патч.');
    this.authenticate(input.data.operatorSecret);
    const {
      operatorSecret: _operatorSecret,
      confirmation: _confirmation,
      ...proposal
    } = input.data;
    void _operatorSecret;
    void _confirmation;
    const report = await this.verifiedProposal(sessionId, planId, proposal);
    this.authenticate(input.data.operatorSecret);
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= Date.now()) this.grants.delete(key);
    }
    if (this.grants.size >= MAX_GRANTS)
      throw new ConflictException('Забагато незавершених дозволів.');
    const token = randomBytes(32).toString('base64url');
    const grant: Grant = {
      id: randomUUID(),
      sessionId,
      planId,
      expiresAt: Date.now() + TTL_MS,
      fingerprint: report.fingerprint,
      sourceCommit: report.sourceCommit,
      filePath: report.filePath,
      expectedSourceSha256: report.sourceSha256,
      patchSha256: report.patchSha256,
      proposedSha256: report.proposedSha256,
    };
    try {
      await audit(grant, 'issued');
    } catch {
      throw new ServiceUnavailableException('Неможливо безпечно видати дозвіл без аудиту.');
    }
    this.grants.set(sha(token), grant);
    return {
      grantToken: token,
      grantId: grant.id,
      expiresAt: new Date(grant.expiresAt).toISOString(),
      filePath: grant.filePath,
      sourceCommit: grant.sourceCommit,
      patchSha256: grant.patchSha256,
      proposedSha256: grant.proposedSha256,
      purpose: 'WRITE_ONE_APPROVED_WORKTREE_FILE',
    };
  }

  async apply(sessionId: string, planId: string, body: unknown): Promise<WorktreePatchApplyResult> {
    const input = executeSchema.safeParse(body);
    if (!input.success) throw new BadRequestException('Некоректний запит застосування патча.');
    // Consume before any await: duplicate/concurrent requests cannot reuse a grant.
    const tokenSha = sha(input.data.grantToken);
    const grant = this.grants.get(tokenSha);
    this.grants.delete(tokenSha);
    this.authenticate(input.data.operatorSecret);
    if (
      !grant ||
      grant.expiresAt <= Date.now() ||
      grant.sessionId !== sessionId ||
      grant.planId !== planId ||
      grant.fingerprint !== input.data.fingerprint ||
      grant.sourceCommit !== input.data.sourceCommit ||
      grant.filePath !== input.data.filePath ||
      grant.expectedSourceSha256 !== input.data.expectedSourceSha256 ||
      grant.patchSha256 !== sha(input.data.patch)
    ) {
      throw new ConflictException(
        'Одноразовий дозвіл недійсний, прострочений або вже використаний.',
      );
    }
    if (this.activePlans.has(planId))
      throw new ConflictException('Інший запис цього worktree виконується.');
    this.activePlans.add(planId);

    let lock: FileHandle | null = null;
    let lockPath = '';
    try {
      const privateDir = await privateStateDir();
      lockPath = join(privateDir, planId + '.lock');
      try {
        lock = await open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        await lock.writeFile(
          JSON.stringify({ grantId: grant.id, startedAt: new Date().toISOString() }),
        );
        await lock.sync();
      } catch {
        throw new ConflictException(
          'Worktree зайнятий або лишився lock після попереднього запису. Потрібен ручний огляд.',
        );
      }
      await audit(grant, 'attempted');
      const proposal = {
        fingerprint: input.data.fingerprint,
        sourceCommit: input.data.sourceCommit,
        filePath: input.data.filePath,
        expectedSourceSha256: input.data.expectedSourceSha256,
        patch: input.data.patch,
      };
      const checked = await this.verifiedProposal(sessionId, planId, proposal);
      this.authenticate(input.data.operatorSecret);
      if (
        checked.proposedSha256 !== grant.proposedSha256 ||
        checked.patchSha256 !== grant.patchSha256
      ) {
        throw new ConflictException('Запропонований патч змінився після погодження.');
      }
      const plan = await this.plans.availableForMountProbe(sessionId, planId);
      if (plan.fingerprint !== grant.fingerprint || plan.baseHeadSha !== grant.sourceCommit) {
        throw new ConflictException('Вихідний план змінився.');
      }
      // The same pure parser computes the bytes to be written. Never execute
      // shell, git apply, hooks, project scripts or user-controlled commands.
      const sourcePath = join(plan.targetPath, ...grant.filePath.split('/'));
      const current = await readFile(sourcePath, { encoding: 'utf8' });
      if (sha(current) !== grant.expectedSourceSha256)
        throw new ConflictException('Файл змінився.');
      const source: WorktreeCodeReadResult = {
        sessionId,
        planId,
        filePath: grant.filePath,
        content: current,
        checkedAt: checked.checkedAt,
        readOnly: true,
        networkEnabled: false,
        containerRemoved: true,
        agentExecutionEnabled: false,
      };
      const review = reviewCodexPatch(source, grant.sourceCommit, input.data.patch);
      if (!review.ok || sha(review.review.afterContent) !== grant.proposedSha256) {
        throw new ConflictException('Патч не відповідає початковому файлу.');
      }
      await replaceOneFile(
        plan.targetPath,
        grant.filePath,
        grant.expectedSourceSha256,
        review.review.afterContent,
      );
      // A complete audit after atomic rename; failure requires manual recovery,
      // never claim the write was rolled back.
      await audit(grant, 'applied');
      return {
        sessionId,
        planId,
        grantId: grant.id,
        filePath: grant.filePath,
        sourceCommit: grant.sourceCommit,
        sourceSha256: grant.expectedSourceSha256,
        proposedSha256: grant.proposedSha256,
        appliedAt: new Date().toISOString(),
        status: 'applied',
        mergeEnabled: false,
        githubPushEnabled: false,
      };
    } catch (error) {
      await audit(grant, 'rejected').catch(() => {
        // The original failure is preserved. Audit failures are fail-closed.
      });
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        'Не вдалося застосувати патч. Стан worktree потребує ручної перевірки.',
      );
    } finally {
      if (lock) {
        await lock.close();
        // Remove only a lock held by this attempt, never an unknown foreign lock.
        await unlink(lockPath).catch(() => {
          // Fail closed on the next write until the leftover lock is reviewed.
        });
      }
      this.activePlans.delete(planId);
    }
  }
}
