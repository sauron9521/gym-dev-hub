import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  TaskExecutionGrant,
  TaskExecutionGrantReceipt,
  TaskExecutionGrantRevocation,
  TaskRunnerPreview,
} from '@gym-dev-hub/contracts';
import { TaskRunnerPolicyService } from './task-runner-policy.service.js';

const REPO = 'sauron9521/gym-platform';
const RECIPE = 'API_TYPECHECK';
const COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const MANIFEST_SHA256 = 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';
const TTL_MS = 45_000;
const MAX_GRANTS = 32;
const MAX_AUDIT_BYTES = 1024 * 1024;
const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const grantToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const authorizeSchema = z.strictObject({
  recipeId: z.literal(RECIPE),
  fingerprint,
  sourceCommit: z.literal(COMMIT),
  sourceTree: z.literal(TREE),
  sourceManifestSha256: z.literal(MANIFEST_SHA256),
  confirmation: z.literal('I_APPROVE_API_TYPECHECK_ON_PINNED_SOURCE_ONLY'),
  operatorSecret: z.string().min(32).max(256),
});
const revokeSchema = z.strictObject({
  grantToken,
  operatorSecret: z.string().min(32).max(256),
});
const consumeSchema = z.strictObject({
  grantToken,
  recipeId: z.literal(RECIPE),
  fingerprint,
  sourceCommit: z.literal(COMMIT),
  sourceManifestSha256: z.literal(MANIFEST_SHA256),
});

type Grant = {
  id: string;
  sessionId: string;
  planId: string;
  fingerprint: string;
  recipeId: typeof RECIPE;
  sourceCommit: typeof COMMIT;
  sourceTree: typeof TREE;
  sourceManifestSha256: typeof MANIFEST_SHA256;
  expiresAt: number;
};

type EventType = 'issued' | 'revoked' | 'consumed' | 'consume-denied';

function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Strictly compares the current real worktree preview, not caller-supplied argv. */
function assertPinnedPreview(
  preview: TaskRunnerPreview,
  sessionId: string,
  planId: string,
  approvedFingerprint: string,
): void {
  const boundary = preview.proposedBoundary;
  const generated = Date.parse(preview.generatedAt);
  const age = Date.now() - generated;
  if (
    preview.sessionId !== sessionId ||
    preview.planId !== planId ||
    preview.repository !== REPO ||
    preview.recipeId !== RECIPE ||
    preview.fingerprint !== approvedFingerprint ||
    preview.baseHeadSha !== COMMIT ||
    preview.workingDirectory !== '/workspace' ||
    preview.status !== 'preview-only' ||
    preview.executionEnabled !== false ||
    preview.approvalGranted !== false ||
    preview.runnerImageAvailable !== false ||
    preview.executesUntrustedProjectScripts !== true ||
    JSON.stringify(preview.argv) !==
      JSON.stringify(['pnpm', '--filter', '@gym/api', 'typecheck']) ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 30_000 ||
    boundary.network !== 'none' ||
    boundary.sourceMount !== 'read-only' ||
    boundary.writableArea !== 'ephemeral-tmpfs' ||
    boundary.uid !== 'non-root' ||
    boundary.dockerSocket !== false ||
    boundary.environmentSecrets !== false ||
    boundary.maxDurationSeconds !== 600 ||
    boundary.maxMemoryMiB !== 2048 ||
    boundary.maxCpus !== 2 ||
    boundary.maxPids !== 128 ||
    boundary.maxOutputBytes !== 65536
  ) {
    throw new ConflictException(
      'Рецепт, Git commit, fingerprint або межі виконання не відповідають затвердженим.',
    );
  }
}

@Injectable()
export class TaskExecutionGrantService {
  // Grants live only in memory; restarting the API revokes ALL outstanding
  // capabilities rather than attempting unsafe replay recovery from disk.
  private readonly grants = new Map<string, Grant>();
  private configuredSecretDigest: Buffer | null = null;

  constructor(private readonly policy: TaskRunnerPolicyService) {}

  private configuredSecret(): string {
    if (process.env.DEV_HUB_ENABLE_TASK_GRANTS !== 'true') {
      this.grants.clear();
      this.configuredSecretDigest = null;
      throw new ServiceUnavailableException('Видача дозволів для задач вимкнена.');
    }
    const secret = process.env.DEV_HUB_TASK_GRANT_OPERATOR_SECRET;
    if (
      !secret ||
      Buffer.byteLength(secret, 'utf8') < 32 ||
      Buffer.byteLength(secret, 'utf8') > 256
    ) {
      this.grants.clear();
      this.configuredSecretDigest = null;
      throw new ServiceUnavailableException('Потрібен окремий сильний секрет дозволів задач.');
    }
    const digest = hashSecret(secret);
    if (
      this.configuredSecretDigest &&
      !timingSafeEqual(this.configuredSecretDigest, digest)
    ) {
      this.grants.clear(); // Rotation invalidates every bearer token, even if feature remains on.
    }
    this.configuredSecretDigest = digest;
    return secret;
  }

  private authenticate(operatorSecret: string): void {
    const expected = hashSecret(this.configuredSecret());
    const supplied = hashSecret(operatorSecret);
    if (!timingSafeEqual(expected, supplied)) {
      throw new ForbiddenException('Невірний секрет оператора.');
    }
  }

  private auditFilePath(): string {
    return resolve(
      process.env.DEV_HUB_TASK_GRANT_AUDIT_FILE ??
        resolve(process.cwd(), '.local', 'task-grants.audit.jsonl'),
    );
  }

  /** Append a bounded non-secret record; if this fails, fail closed. */
  private async audit(event: EventType, grant: Grant): Promise<void> {
    const path = this.auditFilePath();
    const parent = dirname(path);
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const directoryInfo = await lstat(parent);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw new Error('Unsafe audit directory');
      }
      const prior = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (prior && (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1)) {
        throw new Error('Audit output is not a safe regular file');
      }
      const fd = await open(
        path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const info = await fd.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > MAX_AUDIT_BYTES ||
          (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
        ) {
          throw new Error('Unsafe audit file');
        }
        const record = JSON.stringify({
          at: new Date().toISOString(),
          event,
          grantId: grant.id,
          sessionId: grant.sessionId,
          planId: grant.planId,
          recipeId: grant.recipeId,
          sourceCommit: grant.sourceCommit,
          sourceTree: grant.sourceTree,
          sourceManifestSha256: grant.sourceManifestSha256,
          fingerprint: grant.fingerprint,
          expiresAt: new Date(grant.expiresAt).toISOString(),
          // No bearer token, operator secret, environment, argv or local path.
        });
        if (Buffer.byteLength(record) > 1200) throw new Error('Audit entry too large');
        await fd.writeFile(record + '\n', 'utf8');
        await fd.sync();
      } finally {
        await fd.close();
      }
    } catch {
      throw new ServiceUnavailableException('Не вдалося безпечно записати журнал дозволів.');
    }
  }

  private clearExpired(now: number): void {
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(key);
    }
  }

  async authorize(
    sessionId: string,
    planId: string,
    input: unknown,
  ): Promise<TaskExecutionGrant> {
    const parsed = authorizeSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректне погодження задачі.');
    this.authenticate(parsed.data.operatorSecret);
    const checked = await this.policy.preview(sessionId, planId, {
      recipeId: parsed.data.recipeId,
      fingerprint: parsed.data.fingerprint,
    });
    assertPinnedPreview(checked, sessionId, planId, parsed.data.fingerprint);

    // Re-check operator configuration and worktree binding after async preview.
    this.authenticate(parsed.data.operatorSecret);
    const now = Date.now();
    this.clearExpired(now);
    if (this.grants.size >= MAX_GRANTS) {
      throw new ConflictException('Досягнуто ліміт одноразових дозволів.');
    }
    const value = randomBytes(32).toString('base64url');
    const grant: Grant = {
      id: randomUUID(),
      sessionId,
      planId,
      recipeId: RECIPE,
      fingerprint: parsed.data.fingerprint,
      sourceCommit: COMMIT,
      sourceTree: TREE,
      sourceManifestSha256: MANIFEST_SHA256,
      expiresAt: now + TTL_MS,
    };
    await this.audit('issued', grant);
    // A revocation or feature-toggle during the async audit must fail closed.
    this.authenticate(parsed.data.operatorSecret);
    if (Date.now() >= grant.expiresAt || this.grants.size >= MAX_GRANTS) {
      throw new ConflictException('Умови погодження змінилися; потрібен новий дозвіл.');
    }
    this.grants.set(hashToken(value), grant);
    return {
      grantId: grant.id,
      grantToken: value,
      recipeId: RECIPE,
      sourceCommit: COMMIT,
      sourceTree: TREE,
      sourceManifestSha256: MANIFEST_SHA256,
      fingerprint: grant.fingerprint,
      expiresAt: new Date(grant.expiresAt).toISOString(),
      purpose: 'AUTHORIZE_ONE_PINNED_API_TYPECHECK',
      executionEnabled: false,
    };
  }

  async revoke(
    sessionId: string,
    planId: string,
    input: unknown,
  ): Promise<TaskExecutionGrantRevocation> {
    const parsed = revokeSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректний запит відкликання.');
    this.authenticate(parsed.data.operatorSecret);
    const key = hashToken(parsed.data.grantToken);
    const grant = this.grants.get(key);
    // Remove synchronously, before any await, even if scope does not match.
    this.grants.delete(key);
    if (
      !grant ||
      grant.sessionId !== sessionId ||
      grant.planId !== planId ||
      Date.now() >= grant.expiresAt
    ) {
      throw new ForbiddenException('Дозвіл недійсний, використаний або прострочений.');
    }
    await this.audit('revoked', grant);
    return { grantId: grant.id, status: 'revoked', executionEnabled: false };
  }

  /**
   * INTERNAL ONLY: exercises single-use consumption and fresh policy checks,
   * without starting any process or returning an executable authorization.
   * No HTTP endpoint calls this in PR #29.
   */
  async consumeForPolicyCheck(
    sessionId: string,
    planId: string,
    input: unknown,
  ): Promise<TaskExecutionGrantReceipt> {
    const parsed = consumeSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректні параметри дозволу.');
    this.configuredSecret();
    const key = hashToken(parsed.data.grantToken);
    const grant = this.grants.get(key);
    this.grants.delete(key); // Atomic single-use consume before any await.
    if (
      !grant ||
      grant.sessionId !== sessionId ||
      grant.planId !== planId ||
      grant.recipeId !== parsed.data.recipeId ||
      grant.fingerprint !== parsed.data.fingerprint ||
      grant.sourceCommit !== parsed.data.sourceCommit ||
      grant.sourceManifestSha256 !== parsed.data.sourceManifestSha256 ||
      Date.now() >= grant.expiresAt
    ) {
      throw new ForbiddenException('Дозвіл недійсний, використаний або прострочений.');
    }
    try {
      const checked = await this.policy.preview(sessionId, planId, {
        recipeId: RECIPE,
        fingerprint: grant.fingerprint,
      });
      assertPinnedPreview(checked, sessionId, planId, grant.fingerprint);
      // Record consumption before returning a success receipt; no execution.
      await this.audit('consumed', grant);
      return {
        grantId: grant.id,
        recipeId: RECIPE,
        status: 'consumed-no-execution',
        executionEnabled: false,
      };
    } catch {
      await this.audit('consume-denied', grant).catch(() => undefined);
      throw new ConflictException('Вихідний код або політика змінилися; дозвіл анульовано.');
    }
  }
}
