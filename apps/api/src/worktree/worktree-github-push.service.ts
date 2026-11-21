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
import type { WorktreeGitHubPushGrant, WorktreeGitHubPushResult } from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';
import {
  inspectLocalCommitForPush,
  assertGitHubBranchAbsent,
  publishExactCommit,
} from './worktree-github-publisher.js';
import { acquireCommitLock } from './worktree-commit-audit.js';
import {
  appendGitHubPushAudit,
  type GitHubPushAuditIdentity,
} from './worktree-github-push-audit.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = z.string().min(32).max(256);
const authorizeSchema = z.strictObject({
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  operatorSecret: secret,
  confirmation: z.literal('I_AUTHORIZE_NEW_TASK_BRANCH_ONLY'),
});
const executeSchema = z.strictObject({
  grantId: z.uuid(),
  grantToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  runId: z.uuid(),
  operatorSecret: secret,
  confirmation: z.literal('I_PUBLISH_THIS_EXACT_COMMIT_TO_NEW_TASK_BRANCH'),
});
type Entry = {
  id: string;
  sessionId: string;
  planId: string;
  branch: string;
  commitSha: string;
  parentSha: string;
  treeSha: string;
  blobSha: string;
  expiresAt: number;
  audit: GitHubPushAuditIdentity;
};

function activeCredentials(operatorSecret: string): string {
  if (process.env.DEV_HUB_ENABLE_GITHUB_PUBLISH !== 'true') {
    throw new ServiceUnavailableException('GitHub task branch publish вимкнено.');
  }
  const configured = process.env.DEV_HUB_GITHUB_PUBLISH_OPERATOR_SECRET;
  if (!configured || Buffer.byteLength(configured) < 32 || Buffer.byteLength(configured) > 256) {
    throw new ServiceUnavailableException('Немає незалежного секрету GitHub publish.');
  }
  if (
    !timingSafeEqual(
      createHash('sha256').update(configured).digest(),
      createHash('sha256').update(operatorSecret).digest(),
    )
  ) {
    throw new ForbiddenException('Невірний операторський секрет GitHub publish.');
  }
  // Only a separate narrowly scoped Contents:write GitHub credential; never
  // reuse the dashboard's GITHUB_TOKEN implicitly.
  const token = process.env.DEV_HUB_GITHUB_PUBLISH_TOKEN;
  if (
    !token ||
    token.length < 32 ||
    token.length > 1024 ||
    token !== token.trim() ||
    /[\s\r\n]/.test(token)
  ) {
    throw new ServiceUnavailableException('Немає GitHub Contents:write токена для publish.');
  }
  return token;
}

/** No Git writes to main. No arbitrary ref, endpoint, force or merge. */
@Injectable()
export class WorktreeGitHubPushService {
  private readonly grants = new Map<string, Entry>();
  private active = false;
  private lastCredentialHash: string | null = null;

  constructor(private readonly plans: WorktreePlanService) {}

  private authorizeOperator(operatorSecret: string): string {
    let token: string;
    try {
      token = activeCredentials(operatorSecret);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) this.grants.clear();
      throw error;
    }
    const fingerprint = hash(process.env.DEV_HUB_GITHUB_PUBLISH_OPERATOR_SECRET! + '\0' + token);
    if (this.lastCredentialHash && this.lastCredentialHash !== fingerprint) {
      this.grants.clear();
    }
    this.lastCredentialHash = fingerprint;
    return token;
  }

  async authorize(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreeGitHubPushGrant> {
    const input = authorizeSchema.safeParse(body);
    if (!input.success) throw new BadRequestException('Некоректний дозвіл GitHub publish.');
    const token = this.authorizeOperator(input.data.operatorSecret);
    if (this.active) throw new ConflictException('Публікація іншої гілки вже триває.');
    const plan = await this.plans.availableForMountProbe(sessionId, planId);
    const current = await inspectLocalCommitForPush(plan, sessionId, planId, input.data.commitSha);
    await assertGitHubBranchAbsent(current.branch, token);
    this.authorizeOperator(input.data.operatorSecret);
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= Date.now()) this.grants.delete(key);
    }
    if (this.grants.size >= 8) throw new ConflictException('Забагато GitHub publish дозволів.');
    const grantToken = randomBytes(32).toString('base64url');
    const grantId = randomUUID();
    const expiresAt = Date.now() + 45_000;
    const entry: Entry = {
      id: grantId,
      sessionId,
      planId,
      branch: current.branch,
      commitSha: current.commitSha,
      parentSha: current.parentSha,
      treeSha: current.treeSha,
      blobSha: current.blobSha,
      expiresAt,
      audit: {
        grantId,
        runId: null,
        sessionId,
        planId,
        commitSha: current.commitSha,
        branch: current.branch,
        parentSha: current.parentSha,
      },
    };
    try {
      await appendGitHubPushAudit('issued', entry.audit);
    } catch {
      throw new ServiceUnavailableException('Не вдалося записати дозвіл у локальний журнал.');
    }
    this.authorizeOperator(input.data.operatorSecret);
    this.grants.set(hash(grantToken), entry);
    return {
      grantId,
      grantToken,
      branch: current.branch,
      commitSha: current.commitSha,
      parentSha: current.parentSha,
      expiresAt: new Date(expiresAt).toISOString(),
      purpose: 'CREATE_NEW_GITHUB_TASK_BRANCH_ONLY',
      forcePushEnabled: false,
      mainWriteEnabled: false,
      pullRequestEnabled: false,
      mergeEnabled: false,
    };
  }

  async execute(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreeGitHubPushResult> {
    const input = executeSchema.safeParse(body);
    if (!input.success) throw new BadRequestException('Некоректний GitHub publish запит.');
    const lookup = hash(input.data.grantToken);
    const grant = this.grants.get(lookup);
    this.grants.delete(lookup); // One-time capability burned before awaits.
    const token = this.authorizeOperator(input.data.operatorSecret);
    if (
      !grant ||
      grant.id !== input.data.grantId ||
      grant.sessionId !== sessionId ||
      grant.planId !== planId ||
      grant.expiresAt <= Date.now()
    ) {
      throw new ConflictException('GitHub grant недійсний, вичерпаний або повторно використаний.');
    }
    if (this.active) throw new ConflictException('Інша публікація GitHub вже триває.');
    this.active = true;
    let lock: Awaited<ReturnType<typeof acquireCommitLock>> | null = null;
    let refAttempted = false;
    let attempted = false;
    let published = false;
    const audit = { ...grant.audit, runId: input.data.runId };
    try {
      lock = await acquireCommitLock(planId); // Shared with local commit writer.
      this.authorizeOperator(input.data.operatorSecret);
      await appendGitHubPushAudit('attempted', audit);
      attempted = true;
      const plan = await this.plans.availableForMountProbe(sessionId, planId);
      const current = await inspectLocalCommitForPush(plan, sessionId, planId, grant.commitSha);
      if (
        current.branch !== grant.branch ||
        current.parentSha !== grant.parentSha ||
        current.treeSha !== grant.treeSha ||
        current.blobSha !== grant.blobSha
      ) {
        throw new ConflictException('Git commit або task branch змінилися.');
      }
      const checkJustBeforeRef = async () => {
        this.authorizeOperator(input.data.operatorSecret);
        const nextPlan = await this.plans.availableForMountProbe(sessionId, planId);
        const next = await inspectLocalCommitForPush(nextPlan, sessionId, planId, grant.commitSha);
        if (
          next.branch !== current.branch ||
          next.treeSha !== current.treeSha ||
          next.blobSha !== current.blobSha ||
          next.rawContent.compare(current.rawContent) !== 0 ||
          next.parentSha !== current.parentSha
        ) {
          throw new ConflictException('Локальна task-гілка змінилася під час публікації.');
        }
      };
      await publishExactCommit(current, token, checkJustBeforeRef, () => {
        refAttempted = true;
      });
      await appendGitHubPushAudit('published', audit);
      published = true;
      await lock.release();
      lock = null;
      return {
        runId: input.data.runId,
        grantId: grant.id,
        commitSha: current.commitSha,
        parentSha: current.parentSha,
        branch: current.branch,
        branchUrl: 'https://github.com/sauron9521/gym-dev-hub/tree/' + current.branch,
        status: 'published',
        forcePushEnabled: false,
        mainWriteEnabled: false,
        pullRequestCreated: false,
        mergeEnabled: false,
      };
    } catch (error) {
      if (attempted && !published) {
        await appendGitHubPushAudit('rejected', audit).catch(() => undefined);
      }
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        refAttempted
          ? 'Віддалена гілка могла бути створена. Повтор заборонено. Перевір GitHub і локальний lock вручну.'
          : 'GitHub publish зупинено до створення remote task branch.',
      );
    } finally {
      // If POST /git/refs was attempted, a lost response is ambiguous. Retain
      // lock after any error so the operator must inspect remote state first.
      if (lock && !refAttempted) {
        await lock.release().catch(() => undefined);
      }
      this.active = false;
    }
  }
}
