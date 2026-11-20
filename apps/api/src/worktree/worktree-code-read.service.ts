import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { z } from 'zod';
import type {
  WorktreeCodeReadGrant,
  WorktreeCodeReadResult,
  WorktreePlan,
} from '@gym-dev-hub/contracts';
import { BoundaryService } from '../boundary/boundary.service.js';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreeIntegrityService } from './worktree-integrity.service.js';
import { runMountedWorkerProbe, validateScopedCodePath } from './worktree-mount-probe.js';
import { withPinnedFileStage } from './worktree-file-stage.js';

const TTL_MS = 60_000;
const MAX_READ_BYTES = 8_192;
const authorizeSchema = z.strictObject({
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  operatorSecret: z.string().min(32).max(256),
  filePath: z.string().min(1).max(160),
});
const readSchema = z.strictObject({ grantToken: z.string().min(40).max(256) });

type Grant = {
  sessionId: string;
  planId: string;
  fingerprint: string;
  commit: string;
  sourcePath: string;
  filePath: string;
  expiresAt: number;
};

export async function assertRegularScopedFile(plan: WorktreePlan, filePath: string): Promise<void> {
  validateScopedCodePath(filePath);
  const root = await realpath(plan.targetPath);
  let candidate = root;
  const components = filePath.split('/');
  for (const [index, part] of components.entries()) {
    candidate = join(candidate, part);
    const status = await lstat(candidate);
    if (status.isSymbolicLink()) throw new Error('Symbolic link denied');
    if (index < components.length - 1 && !status.isDirectory()) {
      throw new Error('Not a directory');
    }
    if (index === components.length - 1 && (!status.isFile() || status.size > MAX_READ_BYTES)) {
      throw new Error('Not a bounded regular file');
    }
  }
  // Realpath may not escape the approved root through a junction.
  const resolved = await realpath(candidate);
  if (!resolved.startsWith(root + sep)) throw new Error('File escaped scoped mount');
}

@Injectable()
export class WorktreeCodeReadService {
  private readonly grants = new Map<string, Grant>();
  private reading = false;

  constructor(
    private readonly plans: WorktreePlanService,
    private readonly integrity: WorktreeIntegrityService,
    private readonly boundary: BoundaryService,
  ) {}

  private configuredSecret(): string {
    if (
      process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT !== 'true' ||
      process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ !== 'true'
    ) {
      this.grants.clear();
      throw new ServiceUnavailableException('Scoped code reading вимкнено.');
    }
    const secret = process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || secret.length > 256) {
      this.grants.clear();
      throw new ServiceUnavailableException('Потрібен сильний локальний секрет оператора.');
    }
    return secret;
  }

  private requirePreflight(): void {
    const status = this.boundary.status();
    const age = status.checkedAt
      ? Date.now() - Date.parse(status.checkedAt)
      : Number.POSITIVE_INFINITY;
    if (status.state !== 'passed' || !Number.isFinite(age) || age < 0 || age > 5 * 60_000) {
      throw new ConflictException('Потрібен свіжий успішний Docker Safety Preflight.');
    }
  }

  private async verifyPlan(sessionId: string, planId: string): Promise<WorktreePlan> {
    const plan = await this.plans.availableForMountProbe(sessionId, planId);
    if (!plan.baseHeadSha) throw new ConflictException('Немає закріпленого Git commit.');
    const integrity = await this.integrity.verify(sessionId, planId);
    if (
      integrity.status !== 'verified' ||
      integrity.mount.sourcePath !== plan.targetPath ||
      integrity.mount.mountEnabled ||
      integrity.mount.executionEnabled ||
      !integrity.mount.readOnly
    ) {
      throw new ConflictException('Worktree не пройшов Git integrity check.');
    }
    return plan;
  }

  async authorize(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreeCodeReadGrant> {
    const parsed = authorizeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Некоректний запит читання файла.');
    const { fingerprint, filePath, operatorSecret } = parsed.data;
    try {
      validateScopedCodePath(filePath);
    } catch {
      throw new BadRequestException('Недозволений відносний шлях файла.');
    }
    const expected = createHash('sha256').update(this.configuredSecret()).digest();
    const supplied = createHash('sha256').update(operatorSecret).digest();
    if (!timingSafeEqual(expected, supplied)) {
      throw new ForbiddenException('Невірний секрет оператора.');
    }
    this.requirePreflight();
    const plan = await this.verifyPlan(sessionId, planId);
    if (plan.fingerprint !== fingerprint) {
      throw new ConflictException('Змінено fingerprint worktree.');
    }
    try {
      await assertRegularScopedFile(plan, filePath);
    } catch {
      throw new ConflictException('Файл недоступний або перевищує 8 КБ.');
    }
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(key);
    }
    if (this.grants.size >= 100) throw new ConflictException('Забагато активних дозволів.');
    const expiresAt = now + TTL_MS;
    this.grants.set(createHash('sha256').update(token).digest('hex'), {
      sessionId,
      planId,
      fingerprint,
      commit: plan.baseHeadSha!,
      sourcePath: plan.targetPath,
      filePath,
      expiresAt,
    });
    return {
      grantToken: token,
      filePath,
      baseHeadSha: plan.baseHeadSha!,
      expiresAt: new Date(expiresAt).toISOString(),
      purpose: 'READ_ONE_SCOPED_CODE_FILE',
    };
  }

  async read(sessionId: string, planId: string, body: unknown): Promise<WorktreeCodeReadResult> {
    const parsed = readSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Некоректний дозвіл на читання.');
    this.configuredSecret();
    const key = createHash('sha256').update(parsed.data.grantToken).digest('hex');
    const grant = this.grants.get(key);
    this.grants.delete(key); // Consume synchronously before any await.
    if (
      !grant ||
      grant.sessionId !== sessionId ||
      grant.planId !== planId ||
      Date.now() >= grant.expiresAt
    ) {
      throw new ForbiddenException('Дозвіл прострочено або вже використано.');
    }
    if (this.reading) throw new ConflictException('Інше читання ще виконується.');
    this.reading = true;
    let recorded = false;
    try {
      this.requirePreflight();
      const plan = await this.verifyPlan(sessionId, planId);
      if (
        plan.fingerprint !== grant.fingerprint ||
        plan.baseHeadSha !== grant.commit ||
        plan.targetPath !== grant.sourcePath
      ) {
        throw new Error('Approved worktree changed');
      }
      await assertRegularScopedFile(plan, grant.filePath);
      await this.plans.recordCodeRead(sessionId, planId, 'started');
      recorded = true;
      const content = await withPinnedFileStage(plan, grant.filePath, async (stage) => {
        const expected = new TextDecoder('utf-8', { fatal: true }).decode(stage.bytes);
        const actual = await runMountedWorkerProbe(stage.sourcePath, stage.fileName);
        if (actual !== expected) {
          throw new Error('Worker file does not match pinned Git blob');
        }
        return expected;
      });
      await this.plans.recordCodeRead(sessionId, planId, 'completed');
      recorded = false;
      return {
        sessionId,
        planId,
        filePath: grant.filePath,
        content,
        checkedAt: new Date().toISOString(),
        readOnly: true,
        networkEnabled: false,
        containerRemoved: true,
        agentExecutionEnabled: false,
      };
    } catch {
      if (recorded) {
        await this.plans.recordCodeRead(sessionId, planId, 'failed').catch(() => undefined);
      }
      throw new ServiceUnavailableException(
        'Scoped read не виконано. Перевір права читання Docker Desktop, pinned Git blob і видалення snapshot.',
      );
    } finally {
      this.reading = false;
    }
  }
}
