import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { WorktreeMountGrant, WorktreeMountProbeResult } from '@gym-dev-hub/contracts';
import { BoundaryService } from '../boundary/boundary.service.js';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreeIntegrityService } from './worktree-integrity.service.js';
import { runMountedWorkerProbe } from './worktree-mount-probe.js';

const TTL_MS = 60_000;
const PREFLIGHT_MAX_AGE_MS = 5 * 60_000;
const authorizeSchema = z.strictObject({
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  operatorSecret: z.string().min(32).max(256),
});
const runSchema = z.strictObject({
  grantToken: z.string().min(40).max(256),
});
type Grant = {
  sessionId: string;
  planId: string;
  fingerprint: string;
  commit: string;
  sourcePath: string;
  expiresAt: number;
};

@Injectable()
export class WorktreeMountService {
  private readonly grants = new Map<string, Grant>();
  private probing = false;

  constructor(
    private readonly plans: WorktreePlanService,
    private readonly integrity: WorktreeIntegrityService,
    private readonly boundary: BoundaryService,
  ) {}

  private secret(): string {
    if (process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT !== 'true') {
      this.grants.clear();
      throw new ServiceUnavailableException('Read-only Docker mount вимкнено.');
    }
    const secret = process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || secret.length > 256) {
      this.grants.clear();
      throw new ServiceUnavailableException('Не налаштовано сильний локальний секрет оператора.');
    }
    return secret;
  }

  private verifyBoundary(): void {
    const status = this.boundary.status();
    const age = status.checkedAt
      ? Date.now() - Date.parse(status.checkedAt)
      : Number.POSITIVE_INFINITY;
    if (
      status.state !== 'passed' ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > PREFLIGHT_MAX_AGE_MS
    ) {
      throw new ConflictException('Потрібен свіжий успішний Docker Safety Preflight.');
    }
  }

  async authorize(sessionId: string, planId: string, input: unknown): Promise<WorktreeMountGrant> {
    const request = authorizeSchema.safeParse(input);
    if (!request.success) throw new BadRequestException('Некоректний запит погодження mount.');
    const configured = createHash('sha256').update(this.secret()).digest();
    const supplied = createHash('sha256').update(request.data.operatorSecret).digest();
    if (!timingSafeEqual(configured, supplied)) {
      throw new ForbiddenException('Невірний секрет оператора.');
    }
    this.verifyBoundary();
    const plan = await this.plans.availableForMountProbe(sessionId, planId);
    if (plan.fingerprint !== request.data.fingerprint || !plan.baseHeadSha) {
      throw new ConflictException('Маніфест або Git commit не відповідає запиту.');
    }
    const integrity = await this.integrity.verify(sessionId, planId);
    if (
      integrity.status !== 'verified' ||
      integrity.mount.sourcePath !== plan.targetPath ||
      !integrity.mount.readOnly ||
      integrity.mount.executionEnabled ||
      integrity.mount.mountEnabled
    ) {
      throw new ConflictException('Worktree змінився або не пройшов перевірку цілісності.');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + TTL_MS;
    for (const [key, old] of this.grants) {
      if (old.expiresAt <= Date.now()) this.grants.delete(key);
    }
    this.grants.set(createHash('sha256').update(token).digest('hex'), {
      sessionId,
      planId,
      fingerprint: plan.fingerprint,
      commit: plan.baseHeadSha,
      sourcePath: plan.targetPath,
      expiresAt,
    });
    return {
      grantToken: token,
      baseHeadSha: plan.baseHeadSha,
      expiresAt: new Date(expiresAt).toISOString(),
      purpose: 'EPHEMERAL_READ_ONLY_WORKER_MOUNT',
    };
  }

  async probe(
    sessionId: string,
    planId: string,
    input: unknown,
  ): Promise<WorktreeMountProbeResult> {
    const request = runSchema.safeParse(input);
    if (!request.success) throw new BadRequestException('Некоректний одноразовий дозвіл.');
    this.secret();
    const key = createHash('sha256').update(request.data.grantToken).digest('hex');
    const grant = this.grants.get(key);
    this.grants.delete(key); // No awaiting before single-use consumption.
    if (
      !grant ||
      grant.sessionId !== sessionId ||
      grant.planId !== planId ||
      Date.now() >= grant.expiresAt
    ) {
      throw new ForbiddenException('Дозвіл прострочено, використано або він недійсний.');
    }
    if (this.probing) throw new ConflictException('Інший Docker mount probe ще виконується.');
    this.probing = true;
    let recorded = false;
    try {
      this.verifyBoundary();
      const plan = await this.plans.availableForMountProbe(sessionId, planId);
      if (
        plan.fingerprint !== grant.fingerprint ||
        plan.baseHeadSha !== grant.commit ||
        plan.targetPath !== grant.sourcePath
      ) {
        throw new ConflictException('Дозвіл прив’язаний до іншого worktree або Git commit.');
      }
      const result = await this.integrity.verify(sessionId, planId);
      if (result.status !== 'verified' || result.mount.sourcePath !== grant.sourcePath) {
        throw new ConflictException('Worktree більше не відповідає Git blob hash.');
      }

      // Persistent audit is written before any Docker side effects.
      await this.plans.recordMountProbe(sessionId, planId, 'started');
      recorded = true;
      await runMountedWorkerProbe(grant.sourcePath);
      await this.plans.recordMountProbe(sessionId, planId, 'verified');
      recorded = false;
      return {
        planId,
        sessionId,
        state: 'verified',
        checkedAt: new Date().toISOString(),
        sourcePath: grant.sourcePath,
        targetPath: '/workspace',
        readOnly: true,
        networkEnabled: false,
        containerRemoved: true,
        agentExecutionEnabled: false,
      };
    } catch {
      if (recorded) {
        await this.plans.recordMountProbe(sessionId, planId, 'failed').catch(() => undefined);
      }
      throw new ServiceUnavailableException(
        'Docker mount probe відхилено або перервано. Перевір локальний Docker та worktree.',
      );
    } finally {
      this.probing = false;
    }
  }
}
