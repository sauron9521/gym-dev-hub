import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { WorktreePostApplyReview } from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreeIntegrityService } from './worktree-integrity.service.js';
import { validateScopedCodePath } from './worktree-mount-probe.js';

const SHA = /^[a-f0-9]{64}$/;
const MAX_AUDIT_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 32_768;
const requestSchema = z.strictObject({
  grantId: z.uuid(),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  filePath: z.string().min(1).max(160),
  sourceSha256: z.string().regex(SHA),
  proposedSha256: z.string().regex(SHA),
  operatorSecret: z.string().min(32).max(256),
});
type Request = z.infer<typeof requestSchema>;
type AuditLine = {
  at?: string;
  event?: string;
  grantId?: string;
  sessionId?: string;
  planId?: string;
  sourceCommit?: string;
  fingerprint?: string;
  filePathSha256?: string;
  sourceSha256?: string;
  proposedSha256?: string;
};
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function authenticate(operatorSecret: string): void {
  if (process.env.DEV_HUB_ENABLE_PATCH_REVIEW !== 'true') {
    throw new ServiceUnavailableException('Post-apply Git review вимкнений.');
  }
  const secret = process.env.DEV_HUB_PATCH_APPLY_OPERATOR_SECRET;
  if (
    !secret ||
    Buffer.byteLength(secret, 'utf8') < 32 ||
    Buffer.byteLength(secret, 'utf8') > 256
  ) {
    throw new ServiceUnavailableException('Для перегляду потрібен окремий секрет patch apply.');
  }
  const expected = createHash('sha256').update(secret).digest();
  const supplied = createHash('sha256').update(operatorSecret).digest();
  if (!timingSafeEqual(expected, supplied)) {
    throw new ForbiddenException('Невірний секрет для перегляду змін.');
  }
}

async function auditEvents(): Promise<AuditLine[]> {
  const root = resolve(
    process.env.DEV_HUB_PATCH_APPLY_STATE_DIR ?? resolve(process.cwd(), '.local', 'patch-apply'),
  );
  const [stat, canonical] = await Promise.all([lstat(root), realpath(root)]);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical !== root ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error('Unsafe patch audit directory');
  }
  const path = join(root, 'audit.jsonl');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > MAX_AUDIT_BYTES ||
      (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
    ) {
      throw new Error('Unsafe patch audit');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error('Audit changed while reading');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) throw new Error('Incomplete audit log');
    return text
      .trimEnd()
      .split('\n')
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Invalid audit record');
        }
        return parsed as AuditLine;
      });
  } finally {
    await handle.close();
  }
}

function requireAppliedAudit(
  entries: AuditLine[],
  request: Request,
  sessionId: string,
  planId: string,
): void {
  // Reject absent/ambiguous records, including attempts that were rejected
  // after rename or concurrent failures with the same grant.
  const matching = entries.filter((entry) => entry.grantId === request.grantId);
  if (
    matching.filter((entry) => entry.event === 'applied').length !== 1 ||
    matching.some((entry) => entry.event === 'rejected') ||
    matching.some(
      (entry) =>
        entry.sessionId !== sessionId ||
        entry.planId !== planId ||
        entry.sourceCommit !== request.sourceCommit ||
        entry.fingerprint !== request.fingerprint ||
        entry.filePathSha256 !== sha256(request.filePath) ||
        entry.sourceSha256 !== request.sourceSha256 ||
        entry.proposedSha256 !== request.proposedSha256,
    )
  ) {
    throw new ConflictException('Немає однозначного успішного запису для цього файла й grantId.');
  }
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  return env;
}

function gitDiff(cwd: string, args: string[], maxBuffer = MAX_DIFF_BYTES): Promise<Buffer> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=.devhub-disabled-hooks',
        '-C',
        cwd,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--no-color',
        ...args,
      ],
      {
        env: safeGitEnvironment(),
        windowsHide: true,
        shell: false,
        encoding: 'buffer',
        timeout: 12_000,
        maxBuffer,
      },
      (error, output) => {
        if (error || !Buffer.isBuffer(output))
          reject(new Error('Git diff could not be safely read'));
        else resolveOutput(output);
      },
    );
  });
}

function lockPath(planId: string): string {
  const root = resolve(
    process.env.DEV_HUB_PATCH_APPLY_STATE_DIR ?? resolve(process.cwd(), '.local', 'patch-apply'),
  );
  return join(root, planId + '.lock');
}
async function assertNoActiveWrite(planId: string): Promise<void> {
  try {
    await lstat(lockPath(planId));
    throw new ConflictException('Інша зміна триває або залишився lock. Потрібен ручний огляд.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function fixedTestHints(repo: string, path: string): string[] {
  // Static, informational hints. Never executed by this endpoint.
  if (repo === 'sauron9521/gym-dev-hub') {
    if (path.startsWith('apps/api/')) {
      return ['pnpm --filter @gym-dev-hub/api typecheck', 'pnpm --filter @gym-dev-hub/api test'];
    }
    if (path.startsWith('apps/web/')) {
      return ['pnpm --filter @gym-dev-hub/web typecheck', 'pnpm --filter @gym-dev-hub/web test'];
    }
    return ['pnpm check'];
  }
  // Avoid inventing script names for another repository.
  return ['Після ручного огляду запусти відповідні тести та typecheck репозиторію'];
}

@Injectable()
export class WorktreePatchReviewService {
  private running = false;

  constructor(
    private readonly plans: WorktreePlanService,
    private readonly integrity: WorktreeIntegrityService,
  ) {}

  async review(
    sessionId: string,
    planId: string,
    input: unknown,
  ): Promise<WorktreePostApplyReview> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректні параметри Git review.');
    authenticate(parsed.data.operatorSecret);
    try {
      validateScopedCodePath(parsed.data.filePath);
    } catch {
      throw new BadRequestException('Недозволений шлях файла.');
    }
    if (this.running) throw new ConflictException('Інша перевірка змін ще виконується.');
    this.running = true;
    try {
      await assertNoActiveWrite(planId);
      let entries: AuditLine[];
      try {
        entries = await auditEvents();
      } catch {
        throw new ConflictException('Приватний audit відсутній або недоступний.');
      }
      requireAppliedAudit(entries, parsed.data, sessionId, planId);
      const plan = await this.plans.availableForMountProbe(sessionId, planId);
      if (
        plan.baseHeadSha !== parsed.data.sourceCommit ||
        plan.fingerprint !== parsed.data.fingerprint
      ) {
        throw new ConflictException('План, SHA або fingerprint не відповідають аудиту.');
      }
      const overlay = {
        filePath: parsed.data.filePath,
        sourceSha256: parsed.data.sourceSha256,
        proposedSha256: parsed.data.proposedSha256,
      };
      const verified = await this.integrity.verifyOneAppliedFile(sessionId, planId, overlay);
      if (verified.status !== 'verified') {
        throw new ConflictException(
          'Знайдено інші зміни або невідповідність узгодженого файла Git.',
        );
      }
      let diff: string;
      try {
        const changedPaths = await gitDiff(plan.targetPath, ['--name-only', '-z', 'HEAD', '--']);
        const names = changedPaths.toString('utf8').split('\0').filter(Boolean);
        if (names.length !== 1 || names[0] !== parsed.data.filePath) {
          throw new Error('Git reports unexpected changed files');
        }
        const content = await gitDiff(plan.targetPath, [
          '--unified=3',
          'HEAD',
          '--',
          parsed.data.filePath,
        ]);
        diff = new TextDecoder('utf-8', { fatal: true }).decode(content);
        if (!diff || diff.length > MAX_DIFF_BYTES || !diff.includes('@@ ')) {
          throw new Error('No reviewable Git diff');
        }
      } catch {
        throw new ConflictException('Неможливо безпечно перевірити git diff одного файла.');
      }
      // Validate a second time to detect drift while Git generated the diff.
      const latest = await this.integrity.verifyOneAppliedFile(sessionId, planId, overlay);
      if (latest.status !== 'verified') {
        throw new ConflictException('Файли змінилися під час побудови diff.');
      }
      await assertNoActiveWrite(planId);
      return {
        sessionId,
        planId,
        grantId: parsed.data.grantId,
        sourceCommit: plan.baseHeadSha!,
        filePath: parsed.data.filePath,
        sourceSha256: parsed.data.sourceSha256,
        proposedSha256: parsed.data.proposedSha256,
        checkedAt: new Date().toISOString(),
        changedFiles: 1,
        trackedFiles: latest.fileCount,
        diff,
        recommendedChecks: fixedTestHints(plan.repository, parsed.data.filePath),
        status: 'verified',
        readOnly: true,
        testsExecuted: false,
        commitCreated: false,
        pushEnabled: false,
        mergeEnabled: false,
      };
    } finally {
      this.running = false;
    }
  }
}
