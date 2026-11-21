import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  WorktreePatchCheckGrant,
  WorktreePatchCheckResult,
  WorktreePatchCheckCancel,
  WorktreePatchCheckHistory,
} from '@gym-dev-hub/contracts';
import {
  appendPatchCheckAudit,
  readPatchCheckAudit,
  projectPatchCheckHistory,
} from './worktree-patch-check-audit.js';
import { BoundaryService } from '../boundary/boundary.service.js';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreePatchReviewService } from './worktree-patch-review.service.js';
import {
  preparePatchCheckRunner,
  runPatchChecksDocker,
  type FixedPatchRecipe,
} from './worktree-patch-checks-docker.js';

const RECIPES = ['API_TYPECHECK', 'API_TEST', 'WEB_TYPECHECK', 'WEB_TEST'] as const;
const request = z.strictObject({
  grantId: z.uuid(),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  filePath: z.string().min(1).max(160),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  proposedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  recipeId: z.enum(RECIPES),
});
const authorizeSchema = request.extend({
  confirmation: z.literal('I_APPROVE_ONE_FIXED_DOCKER_CHECK'),
  reviewOperatorSecret: z.string().min(32).max(256),
  operatorSecret: z.string().min(32).max(256),
});
const executeSchema = request.extend({
  runId: z.uuid(),
  grantToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  reviewOperatorSecret: z.string().min(32).max(256),
  operatorSecret: z.string().min(32).max(256),
});
const cancelSchema = z.strictObject({
  runId: z.uuid(),
  operatorSecret: z.string().min(32).max(256),
});
type Check = z.infer<typeof request>;
type Grant = Check & { id: string; sessionId: string; planId: string; expiresAt: number };
const TTL = 45_000;
const MAX_GRANTS = 16;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

function authenticate(secret: string): void {
  if (process.env.DEV_HUB_ENABLE_PATCH_CHECKS !== 'true') {
    throw new ServiceUnavailableException('Ізольовані post-apply checks вимкнено.');
  }
  const configured = process.env.DEV_HUB_PATCH_CHECK_OPERATOR_SECRET;
  if (!configured || Buffer.byteLength(configured) < 32 || Buffer.byteLength(configured) > 256) {
    throw new ServiceUnavailableException('Потрібен незалежний секрет Docker check.');
  }
  const expected = createHash('sha256').update(configured).digest();
  const supplied = createHash('sha256').update(secret).digest();
  if (!timingSafeEqual(expected, supplied)) {
    throw new ForbiddenException('Невірний секрет Docker check.');
  }
}

function verifyBoundary(boundary: BoundaryService): void {
  const status = boundary.status();
  const age = status.checkedAt ? Date.now() - Date.parse(status.checkedAt) : Infinity;
  if (status.state !== 'passed' || !Number.isFinite(age) || age < 0 || age > 300_000) {
    throw new ConflictException('Потрібен свіжий Docker Safety Preflight.');
  }
}

function verifyRecipeScope(check: Check, repository: string): void {
  if (repository !== 'sauron9521/gym-dev-hub') {
    throw new ConflictException('Цей fixed recipe працює лише з Gym Dev Hub.');
  }
  const prefix = check.recipeId.startsWith('API_') ? 'apps/api/src/' : 'apps/web/src/';
  if (
    !check.filePath.startsWith(prefix) ||
    check.filePath.split('/').some((p) => !p || p === '..' || p === '.' || p === '.git') ||
    /[\\\r\n\0]/.test(check.filePath)
  ) {
    throw new ConflictException('Recipe обмежений одним файлом у відповідному src пакеті.');
  }
}

@Injectable()
export class WorktreePatchChecksService {
  private readonly grants = new Map<string, Grant>();
  private active: {
    runId: string;
    sessionId: string;
    planId: string;
    grant: Grant;
    abort: AbortController;
    attempted: Promise<void> | null;
    attemptedWritten: boolean;
    cancelAudit: Promise<void> | null;
    finishing: boolean;
  } | null = null;
  private secretDigest: Buffer | null = null;

  constructor(
    private readonly plans: WorktreePlanService,
    private readonly review: WorktreePatchReviewService,
    private readonly boundary: BoundaryService,
  ) {}

  private requireSecret(value: string): void {
    try {
      authenticate(value);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) this.grants.clear();
      throw error;
    }
    const hash = createHash('sha256')
      .update(process.env.DEV_HUB_PATCH_CHECK_OPERATOR_SECRET!)
      .digest();
    if (this.secretDigest && !timingSafeEqual(hash, this.secretDigest)) this.grants.clear();
    this.secretDigest = hash;
  }

  private async revalidate(
    sessionId: string,
    planId: string,
    check: Check,
    reviewSecret: string,
  ): Promise<{ worktree: string }> {
    const plan = await this.plans.availableForMountProbe(sessionId, planId);
    verifyRecipeScope(check, plan.repository);
    if (plan.fingerprint !== check.fingerprint || plan.baseHeadSha !== check.sourceCommit) {
      throw new ConflictException('Pinned worktree commit або fingerprint змінився.');
    }
    const verified = await this.review.review(sessionId, planId, {
      grantId: check.grantId,
      fingerprint: check.fingerprint,
      sourceCommit: check.sourceCommit,
      filePath: check.filePath,
      sourceSha256: check.sourceSha256,
      proposedSha256: check.proposedSha256,
      operatorSecret: reviewSecret,
    });
    if (
      verified.status !== 'verified' ||
      verified.changedFiles !== 1 ||
      verified.sourceCommit !== check.sourceCommit ||
      verified.proposedSha256 !== check.proposedSha256 ||
      verified.filePath !== check.filePath
    ) {
      throw new ConflictException('Post-apply Git review змінився або не підтверджений.');
    }
    return { worktree: plan.targetPath };
  }

  async authorize(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreePatchCheckGrant> {
    const input = authorizeSchema.safeParse(body);
    if (!input.success) throw new BadRequestException('Некоректний fixed Docker check grant.');
    this.requireSecret(input.data.operatorSecret);
    verifyBoundary(this.boundary);
    const {
      confirmation: _confirm,
      operatorSecret: _secret,
      reviewOperatorSecret,
      ...check
    } = input.data;
    void _confirm;
    void _secret;
    if (this.active) throw new ConflictException('Інший Docker check уже виконується.');
    await this.revalidate(sessionId, planId, check, reviewOperatorSecret);
    this.requireSecret(input.data.operatorSecret);
    verifyBoundary(this.boundary);
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= Date.now()) this.grants.delete(key);
    }
    if (this.grants.size >= MAX_GRANTS) throw new ConflictException('Забагато Docker-дозволів.');
    const token = randomBytes(32).toString('base64url');
    const grant: Grant = {
      ...check,
      id: randomUUID(),
      sessionId,
      planId,
      expiresAt: Date.now() + TTL,
    };
    try {
      await appendPatchCheckAudit('issued', grant);
    } catch {
      throw new ServiceUnavailableException('Не вдалося записати audit дозволу Docker check.');
    }
    this.requireSecret(input.data.operatorSecret);
    if (grant.expiresAt <= Date.now()) throw new ConflictException('Дозвіл уже прострочений.');
    this.grants.set(digest(token), grant);
    return {
      grantId: grant.id,
      grantToken: token,
      recipeId: grant.recipeId,
      filePath: grant.filePath,
      proposedSha256: grant.proposedSha256,
      expiresAt: new Date(grant.expiresAt).toISOString(),
      purpose: 'AUTHORIZE_ONE_FIXED_POST_APPLY_DOCKER_CHECK',
    };
  }

  async execute(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreePatchCheckResult> {
    const input = executeSchema.safeParse(body);
    if (!input.success) throw new BadRequestException('Некоректний fixed Docker check.');
    const tokenHash = digest(input.data.grantToken);
    const grant = this.grants.get(tokenHash);
    this.grants.delete(tokenHash); // Burn synchronously: replay/concurrency denied.
    this.requireSecret(input.data.operatorSecret);
    const {
      grantToken: _token,
      operatorSecret: _secret,
      reviewOperatorSecret,
      runId,
      ...check
    } = input.data;
    void _token;
    void _secret;
    if (
      !grant ||
      grant.expiresAt <= Date.now() ||
      grant.sessionId !== sessionId ||
      grant.planId !== planId ||
      grant.grantId !== check.grantId ||
      grant.fingerprint !== check.fingerprint ||
      grant.sourceCommit !== check.sourceCommit ||
      grant.filePath !== check.filePath ||
      grant.sourceSha256 !== check.sourceSha256 ||
      grant.proposedSha256 !== check.proposedSha256 ||
      grant.recipeId !== check.recipeId
    ) {
      throw new ConflictException('Одноразовий Docker grant недійсний або використаний.');
    }
    if (this.active) throw new ConflictException('Інша Docker задача вже виконується.');
    const current = {
      runId,
      sessionId,
      planId,
      grant,
      abort: new AbortController(),
      attempted: null as Promise<void> | null,
      attemptedWritten: false,
      cancelAudit: null as Promise<void> | null,
      finishing: false,
    };
    this.active = current;
    const started = Date.now();
    try {
      verifyBoundary(this.boundary);
      current.attempted = appendPatchCheckAudit('attempted', grant, runId);
      await current.attempted;
      current.attemptedWritten = true;
      const first = await this.revalidate(sessionId, planId, check, reviewOperatorSecret);
      if (current.abort.signal.aborted) throw new ConflictException('Завдання скасовано.');
      const prepared = await preparePatchCheckRunner(first.worktree);
      this.requireSecret(input.data.operatorSecret);
      verifyBoundary(this.boundary);
      const second = await this.revalidate(sessionId, planId, check, reviewOperatorSecret);
      if (second.worktree !== first.worktree || current.abort.signal.aborted) {
        throw new ConflictException('Worktree змінився або завдання скасоване.');
      }
      const outcome = await runPatchChecksDocker(
        prepared,
        check.recipeId as FixedPatchRecipe,
        check.filePath,
        check.proposedSha256,
        current.abort.signal,
      );
      if (current.abort.signal.aborted) throw new ConflictException('Завдання скасовано.');
      await this.revalidate(sessionId, planId, check, reviewOperatorSecret);
      if (current.abort.signal.aborted) throw new ConflictException('Завдання скасовано.');
      current.finishing = true; // Cancel after terminal result must never append after "passed".
      await appendPatchCheckAudit('passed', grant, runId, {
        durationMs: Date.now() - started,
        stdoutBytes: outcome.stdoutBytes,
        stderrBytes: outcome.stderrBytes,
        containerRemoved: true,
      });
      return {
        runId,
        grantId: grant.id,
        recipeId: check.recipeId,
        filePath: check.filePath,
        sourceCommit: check.sourceCommit,
        proposedSha256: check.proposedSha256,
        status: 'passed',
        checkedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        stdoutBytes: outcome.stdoutBytes,
        stderrBytes: outcome.stderrBytes,
        containerRemoved: outcome.containerRemoved,
        readOnlySource: true,
        networkEnabled: false,
        arbitraryCommandsEnabled: false,
        commitCreated: false,
        pushEnabled: false,
        mergeEnabled: false,
      };
    } catch (error) {
      current.finishing = true;
      // Cancellation may be requested while the attempted record is flushing.
      // Always preserve attempted -> cancel-requested -> rejected ordering.
      await current.cancelAudit?.catch(() => undefined);
      if (current.attemptedWritten) {
        await appendPatchCheckAudit('rejected', grant, runId, {
          durationMs: Date.now() - started,
          failureKind: current.abort.signal.aborted ? 'canceled' : 'failed',
        }).catch(() => {
          // If audit fails, never claim success or reissue the grant.
          // A lone "attempted" is shown as interrupted / outcome unknown.
        });
      }
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        'Ізольована Docker-перевірка не пройшла або стан невідомий. Перевір Docker та audit.',
      );
    } finally {
      this.active = null;
    }
  }

  async cancel(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreePatchCheckCancel> {
    const input = cancelSchema.safeParse(body);
    if (!input.success) throw new BadRequestException('Некоректний запит скасування Docker check.');
    this.requireSecret(input.data.operatorSecret);
    const current = this.active;
    if (
      !current ||
      current.sessionId !== sessionId ||
      current.planId !== planId ||
      current.runId !== input.data.runId
    ) {
      throw new ConflictException('Немає активної Docker-перевірки з таким runId.');
    }
    if (current.finishing || !current.attempted || current.cancelAudit) {
      throw new ConflictException('Завдання вже завершується або скасування вже запитано.');
    }
    const previous = current.attempted;
    current.cancelAudit = previous.then(() =>
      appendPatchCheckAudit('cancel-requested', current.grant, current.runId),
    );
    current.abort.abort();
    try {
      await current.cancelAudit;
    } catch {
      throw new ServiceUnavailableException(
        'Скасування запрошено, але журнал не підтверджений. Перевір стан Docker.',
      );
    }
    return { runId: current.runId, status: 'cancel-requested' };
  }

  /** Historical metadata only. No Git, Docker, code, tokens or execution. */
  async history(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreePatchCheckHistory> {
    const input = z
      .strictObject({
        operatorSecret: z.string().min(32).max(256),
      })
      .safeParse(body);
    if (!input.success) throw new BadRequestException('Некоректний запит журналу Docker checks.');
    this.requireSecret(input.data.operatorSecret);
    const plans = await this.plans.list(sessionId);
    const plan = plans.find((item) => item.id === planId);
    if (!plan || plan.repository !== 'sauron9521/gym-dev-hub') {
      throw new ConflictException('Невідомий план Gym Dev Hub.');
    }
    try {
      const entries = await readPatchCheckAudit();
      this.requireSecret(input.data.operatorSecret);
      const current = this.active;
      return projectPatchCheckHistory(
        entries,
        sessionId,
        planId,
        current?.sessionId === sessionId && current.planId === planId ? current.runId : null,
        new Set(
          [...this.grants.values()]
            .filter((grant) => grant.sessionId === sessionId && grant.planId === planId)
            .map((grant) => grant.id),
        ),
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Журнал Docker checks недоступний або пошкоджений.');
    }
  }
}
