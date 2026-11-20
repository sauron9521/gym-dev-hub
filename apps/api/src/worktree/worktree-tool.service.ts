import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  WorktreeToolGrant,
  WorktreeToolResult,
  WorktreePlan,
} from '@gym-dev-hub/contracts';
import { BoundaryService } from '../boundary/boundary.service.js';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreeIntegrityService } from './worktree-integrity.service.js';
import { assertRegularScopedFile } from './worktree-code-read.service.js';
import { runMountedWorkerProbe, validateScopedCodePath } from './worktree-mount-probe.js';

const TTL_MS = 60_000;
const authorizeSchema = z.strictObject({
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  tool: z.literal('SHA256_FILE'),
  filePath: z.string().min(1).max(160),
  operatorSecret: z.string().min(32).max(256),
});
const executeSchema = z.strictObject({ grantToken: z.string().min(40).max(256) });

type Grant = {
  sessionId: string;
  planId: string;
  fingerprint: string;
  pinnedCommit: string;
  targetPath: string;
  filePath: string;
  tool: 'SHA256_FILE';
  expiresAt: number;
};

@Injectable()
export class WorktreeToolService {
  private readonly grants = new Map<string, Grant>();
  private executing = false;

  constructor(
    private readonly plans: WorktreePlanService,
    private readonly integrity: WorktreeIntegrityService,
    private readonly boundary: BoundaryService,
  ) {}

  private secret(): string {
    if (
      process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT !== 'true' ||
      process.env.DEV_HUB_ENABLE_WORKER_TOOLS !== 'true'
    ) {
      this.grants.clear();
      throw new ServiceUnavailableException('Інструменти Docker worker вимкнено.');
    }
    const secret = process.env.DEV_HUB_WORKER_TOOL_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || secret.length > 256) {
      this.grants.clear();
      throw new ServiceUnavailableException('Для інструментів потрібен окремий секрет.');
    }
    return secret;
  }

  private preflight(): void {
    const status = this.boundary.status();
    const age = status.checkedAt
      ? Date.now() - Date.parse(status.checkedAt)
      : Number.POSITIVE_INFINITY;
    if (status.state !== 'passed' || !Number.isFinite(age) || age < 0 || age > 5 * 60_000) {
      throw new ConflictException('Потрібен свіжий успішний Docker Safety Preflight.');
    }
  }

  private async verifiedPlan(sessionId: string, planId: string): Promise<WorktreePlan> {
    const plan = await this.plans.availableForMountProbe(sessionId, planId);
    if (!plan.baseHeadSha) throw new ConflictException('Відсутній pinned Git commit.');
    const report = await this.integrity.verify(sessionId, planId);
    if (
      report.status !== 'verified' ||
      report.mount.sourcePath !== plan.targetPath ||
      !report.mount.readOnly ||
      report.mount.mountEnabled ||
      report.mount.executionEnabled
    ) {
      throw new ConflictException('Worktree не пройшов перевірку цілісності.');
    }
    return plan;
  }

  async authorize(sessionId: string, planId: string, input: unknown): Promise<WorktreeToolGrant> {
    const parsed = authorizeSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Недозволений інструмент або запит.');
    const { fingerprint, tool, filePath, operatorSecret } = parsed.data;
    try {
      validateScopedCodePath(filePath);
    } catch {
      throw new BadRequestException('Недозволений шлях для інструмента.');
    }
    const expected = createHash('sha256').update(this.secret()).digest();
    const supplied = createHash('sha256').update(operatorSecret).digest();
    if (!timingSafeEqual(expected, supplied)) {
      throw new ForbiddenException('Неправильний секрет інструментів.');
    }
    this.preflight();
    const plan = await this.verifiedPlan(sessionId, planId);
    if (plan.fingerprint !== fingerprint) {
      throw new ConflictException('Fingerprint не відповідає погодженому worktree.');
    }
    try {
      await assertRegularScopedFile(plan, filePath);
    } catch {
      throw new ConflictException('Дозволено тільки звичайні файли до 8 КБ.');
    }
    const now = Date.now();
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(key);
    }
    if (this.grants.size >= 100) throw new ConflictException('Перевищено кількість дозволів.');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + TTL_MS;
    this.grants.set(createHash('sha256').update(token).digest('hex'), {
      sessionId,
      planId,
      fingerprint,
      pinnedCommit: plan.baseHeadSha!,
      targetPath: plan.targetPath,
      filePath,
      tool,
      expiresAt,
    });
    return {
      grantToken: token,
      purpose: 'RUN_FIXED_WORKER_TOOL',
      tool,
      filePath,
      baseHeadSha: plan.baseHeadSha!,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async execute(sessionId: string, planId: string, input: unknown): Promise<WorktreeToolResult> {
    const parsed = executeSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректний одноразовий дозвіл.');
    this.secret();
    const key = createHash('sha256').update(parsed.data.grantToken).digest('hex');
    const grant = this.grants.get(key);
    this.grants.delete(key); // Consume once, before any asynchronous step.
    if (
      !grant ||
      grant.sessionId !== sessionId ||
      grant.planId !== planId ||
      Date.now() >= grant.expiresAt
    ) {
      throw new ForbiddenException('Дозвіл прострочено, вже використано або він чужий.');
    }
    if (this.executing) throw new ConflictException('Інша перевірка ще виконується.');
    this.executing = true;
    let recorded = false;
    try {
      this.preflight();
      const plan = await this.verifiedPlan(sessionId, planId);
      if (
        plan.fingerprint !== grant.fingerprint ||
        plan.baseHeadSha !== grant.pinnedCommit ||
        plan.targetPath !== grant.targetPath ||
        grant.tool !== 'SHA256_FILE'
      ) {
        throw new Error('Approved tool scope changed');
      }
      await assertRegularScopedFile(plan, grant.filePath);
      await this.plans.recordToolRun(sessionId, planId, 'started');
      recorded = true;
      const sha256 = await runMountedWorkerProbe(grant.targetPath, undefined, grant.filePath);
      if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
        throw new Error('Worker tool did not return a valid digest');
      }
      await this.plans.recordToolRun(sessionId, planId, 'completed');
      recorded = false;
      return {
        sessionId,
        planId,
        tool: grant.tool,
        filePath: grant.filePath,
        sha256,
        checkedAt: new Date().toISOString(),
        readOnly: true,
        networkEnabled: false,
        containerRemoved: true,
        arbitraryCommandExecutionEnabled: false,
        repositoryCodeExecutionEnabled: false,
      };
    } catch {
      if (recorded) {
        await this.plans.recordToolRun(sessionId, planId, 'failed').catch(() => undefined);
      }
      throw new ServiceUnavailableException(
        'Docker tool відхилено. Перевір локальний Docker, права UID 65534 і Git worktree.',
      );
    } finally {
      this.executing = false;
    }
  }
}
