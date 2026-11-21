/** One-use manual Draft PR creation; no update/ready-for-review/merge. */
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
  PullReadiness,
  WorktreeDraftPrGrant,
  WorktreeDraftPrResult,
} from '@gym-dev-hub/contracts';
import { ReadinessService } from '../github/readiness.service.js';
import { WorktreePlanService } from './worktree-plan.service.js';
import { inspectLocalCommitForPush } from './worktree-github-publisher.js';
import { auditedPublishedTaskBranch } from './worktree-github-push-audit.js';
import { acquireCommitLock } from './worktree-commit-audit.js';
import {
  assertNoExistingTaskPr,
  createExactDraftPr,
  verifyPublishedRemoteTask,
  type RemoteTaskBranch,
} from './worktree-github-draft-pr-api.js';
import { appendDraftPrAudit, type DraftPrAuditIdentity } from './worktree-github-draft-pr-audit.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const secretSchema = z.string().min(32).max(256);
const authorizeSchema = z.strictObject({
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  operatorSecret: secretSchema,
  confirmation: z.literal('I_AUTHORIZE_CREATE_ONE_DRAFT_PR_ONLY'),
});
const executeSchema = z.strictObject({
  grantId: z.uuid(),
  grantToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  runId: z.uuid(),
  operatorSecret: secretSchema,
  confirmation: z.literal('I_CREATE_THIS_EXACT_GITHUB_DRAFT_PR'),
});
const ciSchema = z.strictObject({
  prNumber: z.number().int().positive(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
});
type Entry = {
  id: string;
  sessionId: string;
  planId: string;
  expiresAt: number;
  metadata: RemoteTaskBranch;
  audit: DraftPrAuditIdentity;
};

/** Deliberately distinct from GITHUB_TOKEN and the publish Contents token. */
function activeCredentials(secret: string): string {
  if (process.env.DEV_HUB_ENABLE_DRAFT_PR !== 'true') {
    throw new ServiceUnavailableException('Створення Draft PR вимкнено.');
  }
  const expected = process.env.DEV_HUB_DRAFT_PR_OPERATOR_SECRET;
  if (!expected || Buffer.byteLength(expected) < 32 || Buffer.byteLength(expected) > 256) {
    throw new ServiceUnavailableException('Немає незалежного секрету Draft PR.');
  }
  if (
    !timingSafeEqual(
      createHash('sha256').update(secret).digest(),
      createHash('sha256').update(expected).digest(),
    )
  ) {
    throw new ForbiddenException('Невірний секрет Draft PR.');
  }
  const token = process.env.DEV_HUB_DRAFT_PR_TOKEN;
  if (
    !token ||
    token.length < 32 ||
    token.length > 1024 ||
    token !== token.trim() ||
    /[\s\r\n]/.test(token)
  ) {
    throw new ServiceUnavailableException('Немає окремого GitHub Pull requests:write токена.');
  }
  return token;
}
@Injectable()
export class WorktreeGitHubDraftPrService {
  private readonly grants = new Map<string, Entry>();
  private readonly maxGrants = 8;
  private readonly ttl = 45_000;
  private active = false;
  private credentialFingerprint: string | null = null;

  constructor(
    private readonly plans: WorktreePlanService,
    private readonly readiness: ReadinessService,
  ) {}

  private authenticate(secret: string): string {
    let token: string;
    try {
      token = activeCredentials(secret);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) this.grants.clear();
      throw error;
    }
    const next = sha(process.env.DEV_HUB_DRAFT_PR_OPERATOR_SECRET! + '\0' + token);
    if (this.credentialFingerprint && this.credentialFingerprint !== next) {
      this.grants.clear();
    }
    this.credentialFingerprint = next;
    return token;
  }

  private async verifyPlan(
    sessionId: string,
    planId: string,
    commitSha: string,
  ): Promise<RemoteTaskBranch> {
    const plan = await this.plans.availableForMountProbe(sessionId, planId);
    const local = await inspectLocalCommitForPush(plan, sessionId, planId, commitSha);
    const audited = await auditedPublishedTaskBranch(
      sessionId,
      planId,
      local.commitSha,
      local.branch,
    );
    if (audited.parentSha !== local.parentSha) {
      throw new ConflictException('GitHub publish audit не збігається з локальним commit.');
    }
    return {
      branch: local.branch,
      commitSha: local.commitSha,
      parentSha: local.parentSha,
      title: local.subject,
    };
  }

  async authorize(sessionId: string, planId: string, body: unknown): Promise<WorktreeDraftPrGrant> {
    const parsed = authorizeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Некоректний дозвіл створення Draft PR.');
    const token = this.authenticate(parsed.data.operatorSecret);
    if (this.active) throw new ConflictException('Інша операція Draft PR уже виконується.');
    const metadata = await this.verifyPlan(sessionId, planId, parsed.data.commitSha);
    await verifyPublishedRemoteTask(metadata, token);
    await assertNoExistingTaskPr(metadata.branch, token);
    this.authenticate(parsed.data.operatorSecret);
    for (const [key, value] of this.grants) {
      if (value.expiresAt <= Date.now()) this.grants.delete(key);
    }
    if (this.grants.size >= this.maxGrants)
      throw new ConflictException('Забагато Draft PR дозволів.');
    const id = randomUUID();
    const tokenForGrant = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttl;
    const audit: DraftPrAuditIdentity = {
      grantId: id,
      runId: null,
      sessionId,
      planId,
      branch: metadata.branch,
      commitSha: metadata.commitSha,
      titleSha256: sha(metadata.title),
    };
    try {
      await appendDraftPrAudit('issued', audit);
    } catch {
      throw new ServiceUnavailableException('Не вдалося зберегти дозвіл Draft PR.');
    }
    this.authenticate(parsed.data.operatorSecret);
    this.grants.set(sha(tokenForGrant), {
      id,
      sessionId,
      planId,
      expiresAt,
      metadata,
      audit,
    });
    return {
      grantId: id,
      grantToken: tokenForGrant,
      branch: metadata.branch,
      commitSha: metadata.commitSha,
      title: metadata.title,
      baseBranch: 'main',
      expiresAt: new Date(expiresAt).toISOString(),
      purpose: 'CREATE_ONE_GITHUB_DRAFT_PR_ONLY',
      draft: true,
      branchWriteEnabled: false,
      mergeEnabled: false,
    };
  }

  async execute(sessionId: string, planId: string, body: unknown): Promise<WorktreeDraftPrResult> {
    const parsed = executeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Некоректний запит створення Draft PR.');
    const id = sha(parsed.data.grantToken);
    const grant = this.grants.get(id);
    this.grants.delete(id); // One use, burned before awaits, including errors.
    const token = this.authenticate(parsed.data.operatorSecret);
    if (
      !grant ||
      grant.id !== parsed.data.grantId ||
      grant.sessionId !== sessionId ||
      grant.planId !== planId ||
      grant.expiresAt <= Date.now()
    ) {
      throw new ConflictException('Draft PR grant недійсний, прострочений або використаний.');
    }
    if (this.active) throw new ConflictException('Створення іншого Draft PR уже триває.');
    this.active = true;
    let lock: Awaited<ReturnType<typeof acquireCommitLock>> | null = null;
    let requestAttempted = false;
    let attempted = false;
    let auditCreated = false;
    const audit = { ...grant.audit, runId: parsed.data.runId };
    try {
      lock = await acquireCommitLock(planId);
      this.authenticate(parsed.data.operatorSecret);
      await appendDraftPrAudit('attempted', audit);
      attempted = true;
      const current = await this.verifyPlan(sessionId, planId, grant.metadata.commitSha);
      if (JSON.stringify(current) !== JSON.stringify(grant.metadata)) {
        throw new ConflictException('Опублікована GitHub task-гілка змінилася.');
      }
      const beforeCreate = async () => {
        this.authenticate(parsed.data.operatorSecret);
        const currentAgain = await this.verifyPlan(sessionId, planId, grant.metadata.commitSha);
        if (JSON.stringify(currentAgain) !== JSON.stringify(grant.metadata)) {
          throw new ConflictException(
            'GitHub task commit або назва змінилися перед створенням PR.',
          );
        }
      };
      const pr = await createExactDraftPr(current, token, beforeCreate, () => {
        requestAttempted = true;
      });
      await appendDraftPrAudit('created', audit, pr.number);
      auditCreated = true;
      await lock.release();
      lock = null;
      return {
        grantId: grant.id,
        runId: parsed.data.runId,
        number: pr.number,
        url: pr.url,
        branch: pr.headBranch,
        commitSha: pr.headSha,
        title: pr.title,
        baseBranch: 'main',
        draft: true,
        status: 'draft-created',
        mergeEnabled: false,
        branchWriteEnabled: false,
      };
    } catch (error) {
      if (attempted && !auditCreated) {
        await appendDraftPrAudit('rejected', audit).catch(() => undefined);
      }
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        requestAttempted
          ? 'Draft PR міг бути створений. Повторювати заборонено; перевір GitHub та локальний lock.'
          : 'Створення Draft PR зупинено до GitHub POST /pulls.',
      );
    } finally {
      if (lock && !requestAttempted) {
        await lock.release().catch(() => undefined);
      }
      this.active = false;
    }
  }

  /** Explicit, read-only CI status; uses existing repository readiness logic. */
  async status(sessionId: string, planId: string, body: unknown): Promise<PullReadiness> {
    const parsed = ciSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Некоректний запит CI для Draft PR.');
    const metadata = await this.verifyPlan(sessionId, planId, parsed.data.commitSha);
    const data = await this.readiness.getReadiness(
      'sauron9521/gym-dev-hub',
      String(parsed.data.prNumber),
    );
    if (data.headSha !== metadata.commitSha || !data.draft || data.baseBranch !== 'main') {
      throw new ConflictException('CI не належить перевіреній Draft PR task-гілці.');
    }
    return data;
  }
}
