import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type {
  WorktreeHydrationGrant,
  WorktreeHydrationInspection,
  WorktreePlan,
} from '@gym-dev-hub/contracts';
import { WorktreePlanService, verifyLocalRepository } from './worktree-plan.service.js';

const MAX_FILES = 3000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const GRANT_TTL = 60_000;
const shaPattern = /^[0-9a-f]{40,64}$/;
const authSchema = z.strictObject({
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  operatorSecret: z.string().min(32).max(256),
});
const consumeSchema = z.strictObject({ grantToken: z.string().min(40).max(256) });

type TreeFile = { name: string; oid: string; size: number };
type Snapshot = { files: TreeFile[]; fingerprint: string; bytes: number };
type Grant = { sessionId: string; planId: string; fingerprint: string; expiresAt: number };

function gitEnv(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) result[key] = process.env[key];
  }
  result.GIT_CONFIG_NOSYSTEM = '1';
  result.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  result.GIT_TERMINAL_PROMPT = '0';
  result.GIT_LFS_SKIP_SMUDGE = '1';
  return result;
}

function gitRaw(directory: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    execFile('git', [
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=.devhub-disabled-hooks',
      '-C', directory, ...args,
    ], {
      encoding: 'buffer',
      shell: false,
      windowsHide: true,
      env: gitEnv(),
      maxBuffer,
      timeout: 20_000,
    }, (error, stdout) => {
      if (error) reject(new ServiceUnavailableException('Локальна Git-перевірка не вдалася.'));
      else resolveResult(stdout);
    });
  });
}

function safeName(name: string): void {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('//')) {
    throw new ConflictException('Git містить небезпечний шлях.');
  }
  for (const part of name.split('/')) {
    if (!part || part === '.' || part === '..' ||
        part.toLowerCase() === '.git' ||
        /[<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)) {
      throw new ConflictException('Git містить недозволений шлях.');
    }
  }
}

export function parseSafeTree(data: Buffer): Snapshot {
  const files: TreeFile[] = [];
  const seen = new Set<string>();
  const directories = new Set<string>();
  let bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    if (data.length && data.at(-1) !== 0) throw new Error('Not NUL terminated');
    const records = data.subarray(0, data.length ? -1 : 0).toString('binary').split('\x00');
    for (const record of records) {
      if (!record) continue;
      // Git ls-tree -rlz: <mode> blob <oid> <size> TAB <path> NUL
      const tab = record.indexOf('\t');
      if (tab < 0) throw new Error('Malformed tree record');
      const metadata = record.slice(0, tab);
      const match = /^(100644|100755) blob ([0-9a-f]{40,64}) +([0-9]+)$/.exec(metadata);
      if (!match) throw new Error('Unsupported Git mode (symlink, submodule or tree)');
      const name = decoder.decode(Buffer.from(record.slice(tab + 1), 'binary'));
      safeName(name);
      const size = Number(match[3]);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
        throw new Error('Git file too large');
      }
      const key = name.toLowerCase();
      if (seen.has(key) || directories.has(key)) throw new Error('Case-insensitive path collision');
      const parts = key.split('/');
      for (let i = 1; i < parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        if (seen.has(prefix)) throw new Error('File/directory collision');
        directories.add(prefix);
      }
      seen.add(key);
      files.push({ name, oid: match[2]!, size });
      bytes += size;
      if (files.length > MAX_FILES || bytes > MAX_TOTAL_BYTES) {
        throw new Error('Git tree exceeds safe hydration limits');
      }
    }
  } catch {
    throw new ConflictException(
      'Git дерево містить небезпечні файли, посилання, конфліктні імена або перевищує ліміти.',
    );
  }
  return {
    files,
    bytes,
    fingerprint: 'sha256:' + createHash('sha256').update(data).digest('hex'),
  };
}

@Injectable()
export class WorktreeHydrationService {
  private readonly grants = new Map<string, Grant>();
  private readonly reposRoot = resolve(
    process.env.DEV_HUB_REPOS_ROOT ?? resolve(process.cwd(), '..', '..', '..'),
  );
  private readonly targetRoot = resolve(
    process.env.DEV_HUB_WORKTREES_ROOT ?? resolve(process.cwd(), '.local', 'worktrees'),
  );

  constructor(private readonly plans: WorktreePlanService) {}

  private configuredSecret(): string {
    if (process.env.DEV_HUB_ENABLE_WORKTREE_HYDRATION !== 'true' ||
        process.env.DEV_HUB_ENABLE_WORKTREE_CREATION !== 'true') {
      this.grants.clear();
      throw new ServiceUnavailableException('Наповнення worktree вимкнено у локальній конфігурації.');
    }
    const secret = process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || secret.length > 256) {
      throw new ServiceUnavailableException('Немає достатньо сильного секрету оператора.');
    }
    return secret;
  }

  private async validatedWorktree(plan: WorktreePlan): Promise<void> {
    if (!plan.worktreeCreated || !plan.baseHeadSha || !shaPattern.test(plan.baseHeadSha)) {
      throw new ConflictException('Worktree ще не створено.');
    }
    const source = await verifyLocalRepository(plan.repository, this.reposRoot);
    if (resolve(source).toLowerCase() !== resolve(plan.sourcePath).toLowerCase()) {
      throw new ConflictException('Джерело worktree більше не відповідає плану.');
    }
    const root = resolve(this.targetRoot);
    if (!isAbsolute(root) ||
        resolve(plan.targetPath).toLowerCase() !== resolve(root, plan.id).toLowerCase() ||
        relative(root, plan.targetPath).toLowerCase() !== plan.id.toLowerCase()) {
      throw new ConflictException('Worktree розміщено поза дозволеним root.');
    }
    if ((await realpath(root)).toLowerCase() !== root.toLowerCase() ||
        (await realpath(plan.targetPath)).toLowerCase() !== resolve(plan.targetPath).toLowerCase()) {
      throw new ConflictException('Шлях worktree перенаправлено.');
    }
    const gitPointer = await lstat(join(plan.targetPath, '.git'));
    if (!gitPointer.isFile() || gitPointer.isSymbolicLink()) {
      throw new ConflictException('Git metadata worktree має небезпечний формат.');
    }
    const [top, common, branch, sha] = await Promise.all([
      gitRaw(plan.targetPath, ['rev-parse', '--show-toplevel']),
      gitRaw(plan.targetPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      gitRaw(plan.targetPath, ['symbolic-ref', '-q', '--short', 'HEAD']),
      gitRaw(plan.targetPath, ['rev-parse', '--verify', 'HEAD^{commit}']),
    ]);
    if (resolve(top.toString().trim()).toLowerCase() !== resolve(plan.targetPath).toLowerCase() ||
        resolve(common.toString().trim()).toLowerCase() !== resolve(join(source, '.git')).toLowerCase() ||
        branch.toString().trim() !== plan.proposedBranch ||
        sha.toString().trim() !== plan.baseHeadSha) {
      throw new ConflictException('Git worktree відрізняється від затвердженого плану.');
    }
  }

  private async snapshot(plan: WorktreePlan): Promise<Snapshot> {
    await this.validatedWorktree(plan);
    return parseSafeTree(await gitRaw(
      plan.targetPath, ['ls-tree', '-r', '-l', '-z', '--full-tree', plan.baseHeadSha!],
    ));
  }

  async inspect(sessionId: string, planId: string): Promise<WorktreeHydrationInspection> {
    const plan = await this.plans.ownedPlan(sessionId, planId);
    if (plan.state === 'hydrated') {
      return {
        state: 'hydrated', fileCount: plan.hydratedFileCount ?? 0,
        totalBytes: plan.hydratedBytes ?? 0,
        fingerprint: plan.treeFingerprint ?? null,
        message: 'Файли вже підготовлено. Повторний checkout заборонено.',
        executionEnabled: false,
      };
    }
    if (plan.state !== 'created') {
      return {
        state: 'manual-review', fileCount: 0, totalBytes: 0, fingerprint: null,
        message: 'Потрібна ручна перевірка стану Git; автоматичне очищення вимкнено.',
        executionEnabled: false,
      };
    }
    try {
      const snapshot = await this.snapshot(plan);
      const entries = await readdir(plan.targetPath);
      if (entries.length !== 1 || entries[0] !== '.git') {
        throw new ConflictException('Worktree вже містить файли; повторний checkout заборонено.');
      }
      return {
        state: 'ready',
        fileCount: snapshot.files.length, totalBytes: snapshot.bytes,
        fingerprint: snapshot.fingerprint,
        message: 'Перевірено Git commit та шляхи. Потрібне окреме підтвердження оператора.',
        executionEnabled: false,
      };
    } catch {
      return {
        state: 'blocked', fileCount: 0, totalBytes: 0, fingerprint: null,
        message: 'Безпечне наповнення неможливе. Перевір шлях, Git metadata та дерево коміту.',
        executionEnabled: false,
      };
    }
  }

  async authorize(sessionId: string, planId: string, input: unknown): Promise<WorktreeHydrationGrant> {
    const parsed = authSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректні дані авторизації.');
    const expected = createHash('sha256').update(this.configuredSecret()).digest();
    const actual = createHash('sha256').update(parsed.data.operatorSecret).digest();
    if (!timingSafeEqual(expected, actual)) throw new ForbiddenException('Невірний секрет оператора.');

    const plan = await this.plans.ownedPlan(sessionId, planId);
    if (plan.state !== 'created') throw new ConflictException('Worktree не готовий до наповнення.');
    const report = await this.inspect(sessionId, planId);
    if (report.state !== 'ready' || report.fingerprint !== parsed.data.fingerprint) {
      throw new ConflictException('Git snapshot змінився або preflight не пройдено.');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + GRANT_TTL;
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= Date.now()) this.grants.delete(id);
    }
    this.grants.set(createHash('sha256').update(token).digest('hex'), {
      sessionId, planId, fingerprint: report.fingerprint, expiresAt,
    });
    return {
      grantToken: token, expiresAt: new Date(expiresAt).toISOString(),
      fileCount: report.fileCount, totalBytes: report.totalBytes,
      purpose: 'HYDRATE_SAFE_BLOBS_ONLY',
    };
  }

  async hydrate(sessionId: string, planId: string, input: unknown): Promise<WorktreePlan> {
    const parsed = consumeSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректний одноразовий дозвіл.');
    this.configuredSecret();
    const key = createHash('sha256').update(parsed.data.grantToken).digest('hex');
    const grant = this.grants.get(key);
    this.grants.delete(key); // Consume before the first await.
    if (!grant || grant.sessionId !== sessionId || grant.planId !== planId ||
        grant.expiresAt <= Date.now()) {
      throw new ForbiddenException('Дозвіл недійсний, використаний або прострочений.');
    }
    const plan = await this.plans.reserveHydration(sessionId, planId, grant.fingerprint);
    try {
      const snapshot = await this.snapshot(plan);
      if (snapshot.fingerprint !== grant.fingerprint) throw new Error('Tree changed');
      if ((await readdir(plan.targetPath)).join(',') !== '.git') throw new Error('Worktree not empty');
      for (const file of snapshot.files) {
        const destination = join(plan.targetPath, ...file.name.split('/'));
        if (resolve(destination).toLowerCase().startsWith(resolve(plan.targetPath).toLowerCase() + sep) === false) {
          throw new Error('Unsafe destination');
        }
        await mkdir(dirname(destination), { recursive: true });
        const data = await gitRaw(plan.targetPath, ['cat-file', 'blob', file.oid], MAX_FILE_BYTES + 1024);
        if (data.length !== file.size) throw new Error('Blob size mismatch');
        await writeFile(destination, data, { flag: 'wx', mode: 0o600 });
      }
      return await this.plans.finishHydration(sessionId, planId, 'hydrated', snapshot.files.length, snapshot.bytes);
    } catch {
      await this.plans.finishHydration(sessionId, planId, 'hydrate-failed', 0, 0).catch(() => undefined);
      throw new ServiceUnavailableException(
        'Наповнення перервано. Файли не видаляються; перевір Git worktree вручну.',
      );
    }
  }
}
