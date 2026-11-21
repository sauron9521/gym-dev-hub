import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { WorktreeHydrationGrant, WorktreePlan } from '@gym-dev-hub/contracts';
import { WorktreeInspectionService, inspectTreeListing } from './worktree-inspection.service.js';
import { WorktreePlanService } from './worktree-plan.service.js';

const AUTH_TTL_MS = 60_000;
const MAX_BLOB_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5_000;
const SHA = /^[0-9a-f]{40,64}$/;
const authorizeInput = z.strictObject({
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  operatorSecret: z.string().min(32).max(256),
});
const hydrateInput = z.strictObject({
  grantToken: z.string().min(40).max(256),
});
type Grant = {
  sessionId: string;
  planId: string;
  fingerprint: string;
  commit: string;
  expiresAt: number;
};

type Entry = { path: string; oid: string; size: number };
function parseEntries(listing: string): Entry[] {
  const checked = inspectTreeListing(listing);
  if (checked.violations.length || checked.fileCount > MAX_FILES) {
    throw new ConflictException('Git tree не пройшов перевірку безпеки.');
  }
  if (!listing) return [];
  return listing
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-7]{6}) blob ([0-9a-f]{40,64}) +([0-9]+)\t(.+)$/s.exec(line);
      if (!match || !['100644', '100755'].includes(match[1]!)) {
        throw new ConflictException('Некоректний запис Git tree.');
      }
      return { path: match[4]!, oid: match[2]!, size: Number(match[3]) };
    });
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
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
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

/** Fixed Git object reads and index-only plumbing. No shell or user-supplied Git commands. */
function gitBytes(cwd: string, args: string[], maxBuffer: number): Promise<Buffer> {
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
        ...args,
      ],
      {
        shell: false,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer,
        timeout: 20_000,
        env: isolatedGitEnv(),
      },
      (error, stdout) => {
        if (error) {
          reject(
            new ServiceUnavailableException('Git object недоступний або перевищив обмеження.'),
          );
        } else {
          resolveOutput(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        }
      },
    );
  });
}

async function safeParentDirectories(root: string, relativeFile: string): Promise<string> {
  const components = relativeFile.split('/');
  // All names are validated by inspectTreeListing. Reject data drift explicitly.
  if (
    components.some((part) => !part || part === '.' || part === '..') ||
    components.some((part) => part.toLowerCase() === '.git') ||
    components.some((part) => part.includes('\\') || part.includes(':'))
  ) {
    throw new ConflictException('Некоректне ім’я Git файлу.');
  }
  const rootReal = await realpath(root);
  let at = root;
  for (const component of components.slice(0, -1)) {
    at = join(at, component);
    const prior = await lstat(at).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!prior) {
      await mkdir(at);
    }
    const stat = await lstat(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ConflictException('Символьне посилання у шляху файлу.');
    }
    const actual = await realpath(at);
    const rel = relative(rootReal, actual);
    if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('/') || rel.startsWith('\\')) {
      throw new ConflictException('Папка файлу вказує поза worktree.');
    }
  }
  return join(at, components.at(-1)!);
}

@Injectable()
export class WorktreeHydrationService {
  private readonly grants = new Map<string, Grant>();
  constructor(
    private readonly plans: WorktreePlanService,
    private readonly inspection: WorktreeInspectionService,
  ) {}

  private operatorSecret(): string {
    if (
      process.env.DEV_HUB_ENABLE_WORKTREE_CREATION !== 'true' ||
      process.env.DEV_HUB_ENABLE_WORKTREE_HYDRATION !== 'true'
    ) {
      this.grants.clear();
      throw new ServiceUnavailableException('Hydration вимкнено в локальній конфігурації.');
    }
    const secret = process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || secret.length > 256) {
      this.grants.clear();
      throw new ServiceUnavailableException('Не налаштовано сильний секрет оператора.');
    }
    return secret;
  }

  async authorize(
    sessionId: string,
    planId: string,
    input: unknown,
  ): Promise<WorktreeHydrationGrant> {
    const parsed = authorizeInput.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Неправильне погодження hydration.');
    const expected = createHash('sha256').update(this.operatorSecret()).digest();
    const supplied = createHash('sha256').update(parsed.data.operatorSecret).digest();
    if (!timingSafeEqual(expected, supplied)) {
      throw new ForbiddenException('Невірний секрет оператора.');
    }
    const plan = await this.plans.availableForHydration(sessionId, planId);
    if (plan.fingerprint !== parsed.data.fingerprint) {
      throw new ConflictException('Маніфест змінився.');
    }
    const report = await this.inspection.inspect(plan);
    if (
      report.state !== 'ready-for-hydration' ||
      !plan.baseHeadSha ||
      !SHA.test(plan.baseHeadSha)
    ) {
      throw new ConflictException('Worktree не пройшов read-only перевірку.');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + AUTH_TTL_MS;
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= Date.now()) this.grants.delete(key);
    }
    this.grants.set(createHash('sha256').update(token).digest('hex'), {
      sessionId,
      planId,
      fingerprint: plan.fingerprint,
      commit: plan.baseHeadSha,
      expiresAt,
    });
    return {
      grantToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      baseHeadSha: plan.baseHeadSha,
      purpose: 'WRITE_RAW_GIT_BLOBS_ONLY',
    };
  }

  async hydrate(sessionId: string, planId: string, input: unknown): Promise<WorktreePlan> {
    const parsed = hydrateInput.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректний одноразовий дозвіл.');
    this.operatorSecret();
    const tokenKey = createHash('sha256').update(parsed.data.grantToken).digest('hex');
    const grant = this.grants.get(tokenKey);
    this.grants.delete(tokenKey); // Consume synchronously before any await.
    if (
      !grant ||
      grant.sessionId !== sessionId ||
      grant.planId !== planId ||
      Date.now() >= grant.expiresAt
    ) {
      throw new ForbiddenException('Дозвіл прострочений, використаний або недійсний.');
    }

    const plan = await this.plans.availableForHydration(sessionId, planId);
    if (plan.fingerprint !== grant.fingerprint || plan.baseHeadSha !== grant.commit) {
      throw new ConflictException('Погоджений Git commit більше не відповідає плану.');
    }
    const report = await this.inspection.inspect(plan);
    if (report.state !== 'ready-for-hydration') {
      throw new ConflictException('Worktree змінився після погодження. Hydration заблоковано.');
    }
    const reserved = await this.plans.reserveHydration(
      sessionId,
      planId,
      grant.fingerprint,
      grant.commit,
    );
    try {
      const listing = (
        await gitBytes(
          reserved.sourcePath,
          ['ls-tree', '-r', '-l', '-z', '--full-tree', grant.commit],
          2 * 1024 * 1024,
        )
      ).toString('utf8');
      const entries = parseEntries(listing);
      if (
        entries.length !== report.fileCount ||
        entries.reduce((sum, entry) => sum + entry.size, 0) !== report.totalBytes
      ) {
        throw new ConflictException('Git tree змінився після перевірки.');
      }
      // Recheck the target's metadata before the first write, after the durable reservation.
      const secondReport = await this.inspection.inspect(reserved);
      if (secondReport.state !== 'ready-for-hydration') {
        throw new ConflictException('Worktree не є порожнім або Git metadata змінилися.');
      }
      let filesWritten = 0;
      let bytesWritten = 0;
      for (const entry of entries) {
        const dest = await safeParentDirectories(reserved.targetPath, entry.path);
        const data = await gitBytes(
          reserved.sourcePath,
          ['cat-file', 'blob', entry.oid],
          MAX_BLOB_BYTES + 1,
        );
        if (data.length !== entry.size) {
          throw new ConflictException('Git blob не відповідає очікуваному розміру.');
        }
        const handle = await open(
          dest,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        filesWritten++;
        bytesWritten += data.length;
        if (filesWritten % 25 === 0) {
          await this.plans.recordHydrationProgress(sessionId, planId, filesWritten, bytesWritten);
        }
      }
      // A --no-checkout worktree starts with an empty index. Reconstruct only
      // this worktree's index from the pinned commit after all checked Git blobs
      // are written. read-tree does not checkout files or invoke filters/hooks.
      // Without this step, Git diff misreports the entire repository as deleted.
      await gitBytes(reserved.targetPath, ['read-tree', grant.commit], 1024);
      await gitBytes(
        reserved.targetPath,
        ['diff', '--cached', '--exit-code', grant.commit, '--'],
        1024,
      );
      return await this.plans.finishHydration(
        sessionId,
        planId,
        'completed',
        filesWritten,
        bytesWritten,
      );
    } catch {
      // No destructive cleanup. Partial output is retained for manual inspection.
      await this.plans.finishHydration(sessionId, planId, 'failed').catch(() => undefined);
      throw new ServiceUnavailableException(
        'Hydration перервано. Часткові файли залишено; повторний запуск заблоковано.',
      );
    }
  }
}
