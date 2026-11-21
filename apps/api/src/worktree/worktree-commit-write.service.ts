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
import type { WorktreeCommitWriteGrant, WorktreeCommitWriteResult } from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';
import {
  WorktreeCommitCandidateService,
  type ReviewedCommitEvidence,
} from './worktree-commit-candidate.service.js';
import { configuredCommitIdentity, fixedOneFileCommit } from './worktree-fixed-commit.js';
import {
  acquireCommitLock,
  checkedCommitDirectory,
  commitAudit,
  type CommitAuditIdentity,
} from './worktree-commit-audit.js';

const TTL = 45_000;
const MAX_GRANTS = 8;
const SECRET = z.string().min(32).max(256);
const authorizationSchema = z.strictObject({
  candidateId: z.uuid(),
  candidateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewOperatorSecret: SECRET,
  candidateOperatorSecret: SECRET,
  commitOperatorSecret: SECRET,
  confirmation: z.literal('I_AUTHORIZE_ONE_LOCAL_GIT_COMMIT_GRANT'),
});
const executeSchema = z.strictObject({
  grantId: z.uuid(),
  grantToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  runId: z.uuid(),
  reviewOperatorSecret: SECRET,
  candidateOperatorSecret: SECRET,
  commitOperatorSecret: SECRET,
  confirmation: z.literal('I_EXECUTE_THIS_ONE_LOCAL_GIT_COMMIT_ONLY'),
});
type Entry = {
  id: string;
  sessionId: string;
  planId: string;
  evidence: ReviewedCommitEvidence;
  expiresAt: number;
  audit: CommitAuditIdentity;
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function operatorAuth(secret: string): void {
  if (process.env.DEV_HUB_ENABLE_GIT_COMMIT !== 'true') {
    throw new ServiceUnavailableException('Контрольований локальний Git commit вимкнено.');
  }
  const configured = process.env.DEV_HUB_GIT_COMMIT_OPERATOR_SECRET;
  if (!configured || Buffer.byteLength(configured) < 32 || Buffer.byteLength(configured) > 256) {
    throw new ServiceUnavailableException('Потрібен новий незалежний Git commit секрет.');
  }
  if (
    !timingSafeEqual(
      createHash('sha256').update(configured).digest(),
      createHash('sha256').update(secret).digest(),
    )
  ) {
    throw new ForbiddenException('Невірний Git commit секрет.');
  }
}

@Injectable()
export class WorktreeCommitWriteService {
  private readonly grants = new Map<string, Entry>();
  private active = false;
  private lastSecret: Buffer | null = null;

  constructor(
    private readonly plans: WorktreePlanService,
    private readonly candidates: WorktreeCommitCandidateService,
  ) {}

  private authenticate(secret: string): void {
    try {
      operatorAuth(secret);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) this.grants.clear();
      throw error;
    }
    const hash = createHash('sha256')
      .update(process.env.DEV_HUB_GIT_COMMIT_OPERATOR_SECRET!)
      .digest();
    if (this.lastSecret && !timingSafeEqual(this.lastSecret, hash)) this.grants.clear();
    this.lastSecret = hash;
  }

  /** Issues one 45-second local-only grant; does not write to Git. */
  async authorize(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreeCommitWriteGrant> {
    const input = authorizationSchema.safeParse(body);
    if (!input.success)
      throw new BadRequestException('Некоректний дозвіл на локальний Git commit.');
    this.authenticate(input.data.commitOperatorSecret);
    configuredCommitIdentity(); // Explicit identity, never auto-infer/impersonate.
    if (this.active) throw new ConflictException('Інший Git commit уже виконується.');
    const evidence = await this.candidates.takeReviewedForCommit(
      sessionId,
      planId,
      input.data.candidateId,
      input.data.candidateSha256,
      input.data.candidateOperatorSecret,
      input.data.reviewOperatorSecret,
    );
    this.authenticate(input.data.commitOperatorSecret);
    const plan = await this.plans.availableForMountProbe(sessionId, planId);
    if (
      plan.repository !== 'sauron9521/gym-dev-hub' ||
      plan.baseHeadSha !== evidence.request.sourceCommit ||
      !/^devhub\/task-[0-9a-f]{32}$/.test(plan.proposedBranch)
    ) {
      throw new ConflictException('Дозволений тільки окремий Git worktree у власній task-гілці.');
    }
    for (const [key, value] of this.grants) {
      if (value.expiresAt <= Date.now()) this.grants.delete(key);
    }
    if (this.grants.size >= MAX_GRANTS) throw new ConflictException('Забагато Git дозволів.');
    const token = randomBytes(32).toString('base64url');
    const grantId = randomUUID();
    const expiresAt = Math.min(Date.now() + TTL, evidence.expiresAt);
    if (expiresAt <= Date.now())
      throw new ConflictException('Час переглянутого кандидата вичерпано.');
    const entry: Entry = {
      id: grantId,
      sessionId,
      planId,
      evidence,
      expiresAt,
      audit: {
        grantId,
        runId: null,
        sessionId,
        planId,
        candidateSha256: evidence.candidateSha256,
        sourceCommit: evidence.request.sourceCommit,
        filePathSha256: sha(evidence.request.filePath),
        subjectSha256: sha(evidence.request.commitSubject),
      },
    };
    try {
      await commitAudit('issued', entry.audit);
    } catch {
      throw new ServiceUnavailableException('Журнал Git commit недоступний. Дозвіл не видано.');
    }
    this.authenticate(input.data.commitOperatorSecret);
    if (entry.expiresAt <= Date.now())
      throw new ConflictException('Git дозвіл уже протерміновано.');
    this.grants.set(sha(token), entry);
    return {
      grantId,
      grantToken: token,
      candidateId: input.data.candidateId,
      candidateSha256: evidence.candidateSha256,
      sourceCommit: evidence.request.sourceCommit,
      commitSubject: evidence.request.commitSubject,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      purpose: 'ONE_LOCAL_GIT_COMMIT_ONLY',
      pushEnabled: false,
      mergeEnabled: false,
    };
  }

  /** Burns grant before awaits; no automatic push, PR or merge. */
  async execute(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreeCommitWriteResult> {
    const input = executeSchema.safeParse(body);
    if (!input.success) throw new BadRequestException('Некоректний запит локального Git commit.');
    const id = sha(input.data.grantToken);
    const entry = this.grants.get(id);
    this.grants.delete(id); // Always one-time, including errors/retries.
    this.authenticate(input.data.commitOperatorSecret);
    if (
      !entry ||
      entry.id !== input.data.grantId ||
      entry.sessionId !== sessionId ||
      entry.planId !== planId ||
      entry.expiresAt <= Date.now()
    ) {
      throw new ConflictException('Git grant недійсний, прострочений або вже використаний.');
    }
    if (this.active) throw new ConflictException('Інший Git commit уже виконується.');
    this.active = true;
    let lock: Awaited<ReturnType<typeof acquireCommitLock>> | null = null;
    let refAdvanced = false;
    let auditCommitted = false;
    let attempted = false;
    const audit = { ...entry.audit, runId: input.data.runId };
    try {
      lock = await acquireCommitLock(planId);
      this.authenticate(input.data.commitOperatorSecret);
      await commitAudit('attempted', audit);
      attempted = true;
      await this.candidates.assertEvidenceCurrent(
        sessionId,
        planId,
        entry.evidence.request,
        entry.evidence.candidateSha256,
        input.data.candidateOperatorSecret,
        input.data.reviewOperatorSecret,
      );
      const plan = await this.plans.availableForMountProbe(sessionId, planId);
      if (
        plan.repository !== 'sauron9521/gym-dev-hub' ||
        plan.baseHeadSha !== entry.evidence.request.sourceCommit
      ) {
        throw new ConflictException('Git worktree змінився перед локальним commit.');
      }
      this.authenticate(input.data.commitOperatorSecret);
      const root = await checkedCommitDirectory();
      const result = await fixedOneFileCommit(
        {
          worktree: plan.targetPath,
          branch: plan.proposedBranch,
          baseSha: entry.evidence.request.sourceCommit,
          path: entry.evidence.request.filePath,
          proposedSha256: entry.evidence.request.proposedSha256,
          subject: entry.evidence.request.commitSubject,
          identity: configuredCommitIdentity(),
          temporaryRoot: root,
        },
        async () => {
          this.authenticate(input.data.commitOperatorSecret);
          await this.candidates.assertEvidenceCurrent(
            sessionId,
            planId,
            entry.evidence.request,
            entry.evidence.candidateSha256,
            input.data.candidateOperatorSecret,
            input.data.reviewOperatorSecret,
          );
        },
        () => {
          refAdvanced = true;
        },
      );
      await commitAudit('committed', audit, result.commitSha);
      auditCommitted = true;
      await lock.release();
      lock = null;
      return {
        runId: input.data.runId,
        grantId: entry.id,
        candidateSha256: entry.evidence.candidateSha256,
        commitSha: result.commitSha,
        parentSha: result.parentSha,
        treeSha: result.treeSha,
        branch: result.branch,
        commitSubject: entry.evidence.request.commitSubject,
        filePathSha256: result.filePathSha256,
        status: 'committed',
        worktreeClean: true,
        pushEnabled: false,
        mergeEnabled: false,
      };
    } catch (error) {
      if (attempted && !auditCommitted) {
        // A crash after ref CAS can leave unknown audit/index state. Never
        // imply rollback or retry; retain the lock if ref advanced.
        await commitAudit('rejected', audit).catch(() => undefined);
      }
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        refAdvanced
          ? 'Git ref міг змінитися. Потрібен ручний огляд Git та audit; повторний запуск заборонено.'
          : 'Локальний Git commit відхилено. Перевір стан worktree та журнал.',
      );
    } finally {
      if (lock && !refAdvanced) {
        try {
          await lock.release();
        } catch {
          /* Leave state for manual inspection, never delete other paths. */
        }
      }
      this.active = false;
    }
  }
}
