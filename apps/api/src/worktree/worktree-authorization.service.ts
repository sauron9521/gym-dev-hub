import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { WorktreePlan, WorktreeCreationGrant } from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreeGitService } from './worktree-git.service.js';

const AUTH_TTL_MS = 60_000;
const authorizeSchema = z.strictObject({
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  operatorSecret: z.string().min(32).max(256),
});
const createSchema = z.strictObject({ grantToken: z.string().min(40).max(256) });

type Grant = {
  sessionId: string;
  planId: string;
  fingerprint: string;
  headSha: string;
  expiresAt: number;
};
@Injectable()
export class WorktreeAuthorizationService {
  private readonly grants = new Map<string, Grant>();
  constructor(
    private readonly plans: WorktreePlanService,
    private readonly git: WorktreeGitService,
  ) {}

  private configSecret(): string {
    if (process.env.DEV_HUB_ENABLE_WORKTREE_CREATION !== 'true') {
      this.grants.clear();
      throw new ServiceUnavailableException(
        'Створення worktree вимкнено. Увімкни DEV_HUB_ENABLE_WORKTREE_CREATION.',
      );
    }
    const secret = process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || secret.length > 256) {
      throw new ServiceUnavailableException(
        'Налаштуй випадковий секрет оператора від 32 символів.',
      );
    }
    return secret;
  }

  async authorize(
    sessionId: string,
    planId: string,
    input: unknown,
  ): Promise<WorktreeCreationGrant> {
    const parsed = authorizeSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректний запит погодження.');
    const expected = createHash('sha256').update(this.configSecret()).digest();
    const supplied = createHash('sha256').update(parsed.data.operatorSecret).digest();
    if (!timingSafeEqual(expected, supplied)) {
      throw new ForbiddenException('Невірний секрет оператора.');
    }
    const plan = await this.plans.approvedPlan(sessionId, planId);
    if (plan.fingerprint !== parsed.data.fingerprint) {
      throw new ConflictException('План змінився. Потрібне нове погодження.');
    }
    const headSha = await this.git.headSha(plan);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + AUTH_TTL_MS;
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= Date.now()) this.grants.delete(key);
    }
    this.grants.set(createHash('sha256').update(token).digest('hex'), {
      sessionId,
      planId,
      fingerprint: plan.fingerprint,
      headSha,
      expiresAt,
    });
    return {
      grantToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      baseHeadSha: headSha,
      purpose: 'CREATE_METADATA_ONLY',
    };
  }

  async create(sessionId: string, planId: string, input: unknown): Promise<WorktreePlan> {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректний одноразовий дозвіл.');
    this.configSecret(); // Disabling the feature immediately blocks outstanding grants.

    const key = createHash('sha256').update(parsed.data.grantToken).digest('hex');
    const grant = this.grants.get(key);
    // Consume synchronously, before any await, so replay/concurrent use is impossible.
    this.grants.delete(key);
    if (
      !grant ||
      grant.sessionId !== sessionId ||
      grant.planId !== planId ||
      Date.now() >= grant.expiresAt
    ) {
      throw new ForbiddenException('Дозвіл недійсний, уже використаний або прострочений.');
    }

    const plan = await this.plans.reserveCreation(
      sessionId,
      planId,
      grant.fingerprint,
      grant.headSha,
    );
    try {
      await this.git.createMetadataWorktree(plan, grant.headSha);
      return await this.plans.finishCreation(sessionId, planId, 'created');
    } catch {
      // No blind cleanup: an interrupted git process may leave a real worktree
      // or branch. Mark as failed and require manual reconciliation.
      await this.plans.finishCreation(sessionId, planId, 'failed').catch(() => undefined);
      throw new ServiceUnavailableException(
        'Не вдалося створити Git worktree. Стан позначено як failed; перевір Git worktree list.',
      );
    }
  }
}
