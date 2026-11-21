import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { constants } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { z } from 'zod';
import {
  MAX_PATCH_CHARS,
  reviewCodexPatch,
  type WorktreeCodeReadResult,
  type WorktreePatchPreflightResult,
} from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreeIntegrityService } from './worktree-integrity.service.js';
import { validateScopedCodePath } from './worktree-mount-probe.js';

const MAX_SOURCE_BYTES = 8_192;
const inputSchema = z.strictObject({
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  filePath: z.string().min(1).max(160),
  expectedSourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  patch: z.string().min(1).max(MAX_PATCH_CHARS),
  operatorSecret: z.string().min(32).max(256),
});

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * A bounded read of a single pre-validated regular file. Double-check both
 * metadata and full worktree integrity. This is a diagnostic, not an atomic
 * promise about a future writable operation: other processes can race it.
 */
async function readVerifiedFile(worktree: string, filePath: string): Promise<string> {
  validateScopedCodePath(filePath);
  const root = await realpath(worktree);
  const pathComponents = filePath.split('/');
  let file = root;
  for (const [index, part] of pathComponents.entries()) {
    file = join(file, part);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error('Symlink in scoped path');
    if (index < pathComponents.length - 1 && !stat.isDirectory()) {
      throw new Error('Non-directory path component');
    }
    if (index === pathComponents.length - 1 && (!stat.isFile() || stat.size > MAX_SOURCE_BYTES)) {
      throw new Error('Unsupported file or file too large');
    }
  }
  const target = await realpath(file);
  if (!target.startsWith(root + sep)) throw new Error('Path escaped source tree');

  const before = await lstat(file);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const fdBefore = await handle.stat();
    if (
      !fdBefore.isFile() ||
      fdBefore.size > MAX_SOURCE_BYTES ||
      before.dev !== fdBefore.dev ||
      before.ino !== fdBefore.ino
    ) {
      throw new Error('Source file identity changed');
    }
    const bytes = await handle.readFile();
    const fdAfter = await handle.stat();
    if (
      bytes.length !== fdBefore.size ||
      fdAfter.dev !== fdBefore.dev ||
      fdAfter.ino !== fdBefore.ino ||
      fdAfter.size !== fdBefore.size ||
      fdAfter.mtimeMs !== fdBefore.mtimeMs ||
      fdAfter.ctimeMs !== fdBefore.ctimeMs
    ) {
      throw new Error('Source changed while reading');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

@Injectable()
export class WorktreePatchPreflightService {
  private running = false;

  constructor(
    private readonly plans: WorktreePlanService,
    private readonly integrity: WorktreeIntegrityService,
  ) {}

  private requireOperator(secret: string): void {
    if (
      process.env.DEV_HUB_ENABLE_PATCH_PREFLIGHT !== 'true' ||
      process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ !== 'true' ||
      process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT !== 'true'
    ) {
      throw new ServiceUnavailableException('Patch preflight вимкнено в локальній конфігурації.');
    }
    const configured = process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET;
    if (!configured || Buffer.byteLength(configured, 'utf8') < 32 || configured.length > 256) {
      throw new ServiceUnavailableException('Потрібен окремо налаштований секрет оператора.');
    }
    const expected = createHash('sha256').update(configured).digest();
    const supplied = createHash('sha256').update(secret).digest();
    if (!timingSafeEqual(expected, supplied)) {
      throw new ForbiddenException('Неправильний секрет оператора.');
    }
  }

  async preview(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreePatchPreflightResult> {
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Некоректні параметри patch preflight.');
    this.requireOperator(parsed.data.operatorSecret);
    try {
      validateScopedCodePath(parsed.data.filePath);
    } catch {
      throw new BadRequestException('Недозволений шлях вихідного файла.');
    }

    // Keep full-tree revalidation bounded to one request at a time.
    if (this.running) throw new ConflictException('Інша перевірка патча ще виконується.');
    this.running = true;
    try {
      const plan = await this.plans.availableForMountProbe(sessionId, planId);
      if (
        plan.fingerprint !== parsed.data.fingerprint ||
        plan.baseHeadSha !== parsed.data.sourceCommit
      ) {
        throw new ConflictException('Git commit або fingerprint більше не збігається.');
      }
      const verify = async () => {
        const report = await this.integrity.verify(sessionId, planId);
        if (
          report.status !== 'verified' ||
          report.mount.sourcePath !== plan.targetPath ||
          !report.mount.readOnly ||
          report.mount.mountEnabled ||
          report.mount.executionEnabled ||
          report.mount.networkEnabled
        ) {
          throw new ConflictException('Worktree змінився або не пройшов перевірку Git.');
        }
      };
      await verify();
      let content: string;
      try {
        content = await readVerifiedFile(plan.targetPath, parsed.data.filePath);
      } catch {
        throw new ConflictException('Немає доступного незміненого Git-файла до 8 КіБ.');
      }
      const sourceSha256 = hash(content);
      if (sourceSha256 !== parsed.data.expectedSourceSha256) {
        throw new ConflictException('Файл змінився після читання: новий read-grant необхідний.');
      }
      const source: WorktreeCodeReadResult = {
        sessionId,
        planId,
        filePath: parsed.data.filePath,
        content,
        checkedAt: new Date().toISOString(),
        readOnly: true,
        networkEnabled: false,
        containerRemoved: true,
        agentExecutionEnabled: false,
      };
      const reviewed = reviewCodexPatch(source, plan.baseHeadSha!, parsed.data.patch);
      if (!reviewed.ok)
        throw new ConflictException('Патч не відповідає Git snapshot або обмеженням.');
      // A second fresh full-tree check detects drift during our bounded read.
      await verify();
      return {
        sessionId,
        planId,
        filePath: parsed.data.filePath,
        sourceCommit: parsed.data.sourceCommit,
        fingerprint: parsed.data.fingerprint,
        checkedAt: new Date().toISOString(),
        sourceSha256,
        patchSha256: hash(parsed.data.patch),
        proposedSha256: hash(reviewed.review.afterContent),
        added: reviewed.review.added,
        removed: reviewed.review.removed,
        integrity: 'verified',
        readOnly: true,
        writeEnabled: false,
        authorizationGranted: false,
      };
    } finally {
      this.running = false;
    }
  }
}
