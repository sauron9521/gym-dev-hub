/**
 * PR #67: read-only proposal for a human-reviewed Git commit.
 *
 * No git add/commit, shell, branch writes, push or merge.  All checks are
 * re-read at acknowledgement time; acknowledgement is NOT an execution grant.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  WorktreeCommitCandidatePreview,
  WorktreeCommitCandidateAcknowledgement,
  WorktreePatchCheckRecipe,
} from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreePatchReviewService } from './worktree-patch-review.service.js';
import { projectPatchCheckHistory, readPatchCheckAudit } from './worktree-patch-check-audit.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const TTL_MS = 5 * 60_000;
const MAX_PENDING = 8;
const subjectSchema = z
  .string()
  .min(10)
  .max(72)
  .refine(
    (subject) =>
      subject === subject.trim() &&
      [...subject].every((character) => {
        const code = character.codePointAt(0)!;
        return code >= 32 && code !== 127;
      }) &&
      /^(feat|fix|refactor|docs|test|chore|perf|build|ci|style)(\([a-z][a-z0-9-]{0,29}\))?: [\p{L}\p{N}][^\r\n]*$/u.test(
        subject,
      ),
    'Use a single-line conventional commit subject (max 72 chars)',
  );
const baseSchema = z.strictObject({
  grantId: z.uuid(),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  filePath: z.string().min(1).max(160),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  proposedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  commitSubject: subjectSchema,
});
const previewSchema = baseSchema.extend({
  reviewOperatorSecret: z.string().min(32).max(256),
  operatorSecret: z.string().min(32).max(256),
});
const acknowledgeSchema = previewSchema.extend({
  candidateId: z.uuid(),
  candidateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal('I_REVIEWED_THIS_COMMIT_CANDIDATE_ONLY'),
});
type Request = z.infer<typeof baseSchema>;
type Stored = {
  sessionId: string;
  planId: string;
  request: Request;
  candidateSha256: string;
  expiresAt: number;
};
function assertFeature(secret: string): void {
  if (process.env.DEV_HUB_ENABLE_COMMIT_CANDIDATE_PREVIEW !== 'true') {
    throw new ServiceUnavailableException('Попередній перегляд кандидата на commit вимкнено.');
  }
  const expected = process.env.DEV_HUB_COMMIT_CANDIDATE_OPERATOR_SECRET;
  if (!expected || Buffer.byteLength(expected) < 32 || Buffer.byteLength(expected) > 256) {
    throw new ServiceUnavailableException('Потрібен незалежний секрет commit candidate.');
  }
  const lhs = createHash('sha256').update(expected).digest();
  const rhs = createHash('sha256').update(secret).digest();
  if (!timingSafeEqual(lhs, rhs)) {
    throw new ForbiddenException('Невірний секрет commit candidate.');
  }
}
function scopedRecipe(filePath: string): readonly WorktreePatchCheckRecipe[] {
  if (filePath.startsWith('apps/api/src/')) return ['API_TYPECHECK', 'API_TEST'];
  if (filePath.startsWith('apps/web/src/')) return ['WEB_TYPECHECK', 'WEB_TEST'];
  throw new ConflictException('Commit candidate має бути одним схваленим source-файлом.');
}
function signature(value: {
  sessionId: string;
  planId: string;
  grantId: string;
  sourceCommit: string;
  filePath: string;
  sourceSha256: string;
  proposedSha256: string;
  fingerprint: string;
  commitSubject: string;
  diffSha256: string;
  verifiedRecipes: readonly WorktreePatchCheckRecipe[];
}): string {
  return sha256(JSON.stringify(value));
}

@Injectable()
export class WorktreeCommitCandidateService {
  private readonly pending = new Map<string, Stored>();
  private lastSecret: Buffer | null = null;

  constructor(
    private readonly plans: WorktreePlanService,
    private readonly review: WorktreePatchReviewService,
  ) {}

  private authenticate(secret: string): void {
    try {
      assertFeature(secret);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) this.pending.clear();
      throw error;
    }
    const digest = createHash('sha256')
      .update(process.env.DEV_HUB_COMMIT_CANDIDATE_OPERATOR_SECRET!)
      .digest();
    if (this.lastSecret && !timingSafeEqual(this.lastSecret, digest)) this.pending.clear();
    this.lastSecret = digest;
  }

  private async revalidate(
    sessionId: string,
    planId: string,
    request: Request,
    reviewSecret: string,
  ): Promise<{
    diff: string;
    diffSha256: string;
    recipes: WorktreePatchCheckRecipe[];
    checkedAt: string;
  }> {
    const plan = await this.plans.availableForMountProbe(sessionId, planId);
    if (
      plan.repository !== 'sauron9521/gym-dev-hub' ||
      plan.fingerprint !== request.fingerprint ||
      plan.baseHeadSha !== request.sourceCommit
    ) {
      throw new ConflictException('Невірний repo, worktree або pinned Git commit.');
    }
    const allowed = scopedRecipe(request.filePath);
    const verified = await this.review.review(sessionId, planId, {
      grantId: request.grantId,
      fingerprint: request.fingerprint,
      sourceCommit: request.sourceCommit,
      filePath: request.filePath,
      sourceSha256: request.sourceSha256,
      proposedSha256: request.proposedSha256,
      operatorSecret: reviewSecret,
    });
    if (
      verified.status !== 'verified' ||
      verified.changedFiles !== 1 ||
      verified.filePath !== request.filePath ||
      verified.sourceCommit !== request.sourceCommit ||
      verified.proposedSha256 !== request.proposedSha256 ||
      !verified.diff ||
      verified.diff.length > 32_768
    ) {
      throw new ConflictException('Фактичний Git diff більше не відповідає кандидату.');
    }
    // Do not trust browser-reported check statuses. Replay the strictly
    // validated on-disk journal, then match both original and post-image SHA.
    const records = await readPatchCheckAudit();
    const projected = projectPatchCheckHistory(records, sessionId, planId, null, new Set());
    const original = new Map(
      records
        .filter(
          (entry) =>
            entry.event === 'issued' && entry.sessionId === sessionId && entry.planId === planId,
        )
        .map((entry) => [entry.grantId, entry]),
    );
    const filePathSha256 = sha256(request.filePath);
    const passed = new Set(
      projected.items
        .filter((entry) => {
          const first = original.get(entry.grantId);
          return (
            entry.status === 'passed' &&
            allowed.includes(entry.recipeId) &&
            entry.sourceCommit === request.sourceCommit &&
            entry.proposedSha256 === request.proposedSha256 &&
            entry.filePathSha256 === filePathSha256 &&
            first?.fingerprint === request.fingerprint &&
            first.sourceSha256 === request.sourceSha256
          );
        })
        .map((entry) => entry.recipeId),
    );
    // At least one real successful fixed check is required to propose a
    // candidate. A missing second check is shown explicitly, not invented.
    if (!passed.size) throw new ConflictException('Спочатку потрібна успішна Docker-перевірка.');
    return {
      diff: verified.diff,
      diffSha256: sha256(verified.diff),
      recipes: allowed.filter((recipe) => passed.has(recipe)),
      checkedAt: verified.checkedAt,
    };
  }

  async preview(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreeCommitCandidatePreview> {
    const parsed = previewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Некоректний commit candidate preview.');
    this.authenticate(parsed.data.operatorSecret);
    const { operatorSecret: _operator, reviewOperatorSecret, ...request } = parsed.data;
    void _operator;
    const result = await this.revalidate(sessionId, planId, request, reviewOperatorSecret);
    this.authenticate(parsed.data.operatorSecret);
    for (const [id, stored] of this.pending) {
      if (stored.expiresAt <= Date.now()) this.pending.delete(id);
    }
    if (this.pending.size >= MAX_PENDING)
      throw new ConflictException('Забагато відкритих кандидатів.');
    const candidateId = randomUUID();
    const candidateSha256 = signature({
      sessionId,
      planId,
      ...request,
      diffSha256: result.diffSha256,
      verifiedRecipes: result.recipes,
    });
    const expiresAt = Date.now() + TTL_MS;
    this.pending.set(candidateId, {
      sessionId,
      planId,
      request,
      candidateSha256,
      expiresAt,
    });
    return {
      candidateId,
      candidateSha256,
      sessionId,
      planId,
      sourceCommit: request.sourceCommit,
      filePath: request.filePath,
      sourceSha256: request.sourceSha256,
      proposedSha256: request.proposedSha256,
      diffSha256: result.diffSha256,
      diff: result.diff,
      commitSubject: request.commitSubject,
      verifiedRecipes: result.recipes,
      missingRecipes: scopedRecipe(request.filePath).filter((r) => !result.recipes.includes(r)),
      checkedAt: result.checkedAt,
      expiresAt: new Date(expiresAt).toISOString(),
      status: 'review-required',
      readOnly: true,
      commitCreated: false,
      stagingEnabled: false,
      pushEnabled: false,
      mergeEnabled: false,
    };
  }

  async acknowledge(
    sessionId: string,
    planId: string,
    body: unknown,
  ): Promise<WorktreeCommitCandidateAcknowledgement> {
    const parsed = acknowledgeSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Некоректне підтвердження commit candidate.');
    const stored = this.pending.get(parsed.data.candidateId);
    // One-time acknowledgement; even rejected attempts cannot reuse it.
    this.pending.delete(parsed.data.candidateId);
    this.authenticate(parsed.data.operatorSecret);
    const {
      candidateId,
      candidateSha256,
      confirmation: _confirm,
      operatorSecret: _operator,
      reviewOperatorSecret,
      ...request
    } = parsed.data;
    void _confirm;
    void _operator;
    if (
      !stored ||
      stored.expiresAt <= Date.now() ||
      stored.sessionId !== sessionId ||
      stored.planId !== planId ||
      stored.candidateSha256 !== candidateSha256 ||
      JSON.stringify(stored.request) !== JSON.stringify(request)
    ) {
      throw new ConflictException('Кандидат змінений, протермінований або вже підтверджений.');
    }
    const validated = await this.revalidate(sessionId, planId, request, reviewOperatorSecret);
    this.authenticate(parsed.data.operatorSecret);
    const latestSha = signature({
      sessionId,
      planId,
      ...request,
      diffSha256: validated.diffSha256,
      verifiedRecipes: validated.recipes,
    });
    if (latestSha !== candidateSha256) {
      throw new ConflictException('Git diff чи статус перевірок змінився. Створи новий preview.');
    }
    return {
      candidateId,
      candidateSha256,
      commitSubject: request.commitSubject,
      acknowledgedAt: new Date().toISOString(),
      status: 'operator-reviewed',
      previewOnly: true,
      commitCreated: false,
      stagingEnabled: false,
      pushEnabled: false,
      mergeEnabled: false,
    };
  }
}
