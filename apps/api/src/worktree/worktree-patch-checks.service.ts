import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type {
  WorktreePatchCheckGrant,
  WorktreePatchCheckResult,
  WorktreePatchCheckCancel,
} from '@gym-dev-hub/contracts';
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
const MAX_AUDIT = 1024 * 1024;
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

/** Fail-closed durable audit: never stores source, token, secrets, diff or local path. */
async function audit(event: string, grant: Grant, runId?: string): Promise<void> {
  const dir = resolve(
    process.env.DEV_HUB_PATCH_CHECK_STATE_DIR ?? resolve(process.cwd(), '.local', 'patch-checks'),
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const [info, canonical] = await Promise.all([lstat(dir), realpath(dir)]);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    canonical !== dir ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  ) {
    throw new Error('Unsafe patch check audit folder');
  }
  const path = join(dir, 'audit.jsonl');
  const old = await lstat(path).catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? null : Promise.reject(error),
  );
  if (old && (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1)) {
    throw new Error('Unsafe patch check audit file');
  }
  const fd = await open(
    path,
    constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_AUDIT ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error('Unsafe patch check log');
    }
    const record = JSON.stringify({
      at: new Date().toISOString(),
      event,
      grantId: grant.id,
      runId: runId ?? null,
      sessionId: grant.sessionId,
      planId: grant.planId,
      recipeId: grant.recipeId,
      fingerprint: grant.fingerprint,
      sourceCommit: grant.sourceCommit,
      filePathSha256: digest(grant.filePath),
      sourceSha256: grant.sourceSha256,
      proposedSha256: grant.proposedSha256,
    });
    if (Buffer.byteLength(record) > 1200) throw new Error('Audit entry too long');
    await fd.writeFile(record + '\n');
    await fd.sync();
  } finally {
    await fd.close();
  }
}

@Injectable()
export class WorktreePatchChecksService {
  private readonly grants = new Map<string, Grant>();
  private active: {
    runId: string;
    sessionId: string;
    planId: string;
    abort: AbortController;
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
      await audit('issued', grant);
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
    const current = { runId, sessionId, planId, abort: new AbortController() };
    this.active = current;
    const started = Date.now();
    try {
      verifyBoundary(this.boundary);
      await audit('attempted', grant, runId);
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
      await audit('passed', grant, runId);
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
      await audit('rejected', grant, runId).catch(() => {
        // Even if audit fails, do not report success or reissue the grant.
      });
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        'Ізольована Docker-перевірка не пройшла або стан невідомий. Перевір Docker та audit.',
      );
    } finally {
      this.active = null;
    }
  }

  cancel(sessionId: string, planId: string, body: unknown): WorktreePatchCheckCancel {
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
    current.abort.abort();
    return { runId: current.runId, status: 'cancel-requested' };
  }
}
