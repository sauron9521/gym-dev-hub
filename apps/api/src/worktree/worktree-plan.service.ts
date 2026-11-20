import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { WorktreePlan, WorktreePlanState } from '@gym-dev-hub/contracts';
import { GitHubService } from '../github/github.service.js';
import { WorkspaceService } from '../workspace/workspace.service.js';

const PLAN_TTL_MS = 15 * 60_000;
const MAX_PLANS = 100;
const uuidSchema = z.uuid();
const auditSchema = z.strictObject({
  event: z.enum([
    'created',
    'acknowledged',
    'revoked',
    'creation-started',
    'worktree-created',
    'creation-failed',
    'hydration-started',
    'hydration-completed',
    'hydration-failed',
    'mount-probe-started',
    'mount-probe-verified',
    'mount-probe-failed',
    'code-read-started',
    'code-read-completed',
    'code-read-failed',
  ]),
  timestamp: z.iso.datetime(),
});
const planSchema = z.strictObject({
  id: uuidSchema,
  sessionId: uuidSchema,
  repository: z.string(),
  sourcePath: z.string(),
  targetPath: z.string(),
  proposedBranch: z.string(),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  state: z.enum(['pending', 'acknowledged', 'revoked', 'creating', 'created', 'failed']),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  history: z.array(auditSchema),
  executionEnabled: z.literal(false),
  worktreeCreated: z.boolean(),
  hydrationState: z.enum(['running', 'completed', 'failed']).optional(),
  hydrationFiles: z.number().int().nonnegative().max(5000).optional(),
  hydrationBytes: z
    .number()
    .int()
    .nonnegative()
    .max(100 * 1024 * 1024)
    .optional(),
  baseHeadSha: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .optional(),
});
const storeSchema = z.strictObject({
  version: z.literal(1),
  plans: z.array(planSchema).max(MAX_PLANS),
});
type Store = z.infer<typeof storeSchema>;
type StoredPlan = Store['plans'][number];

const acknowledgeSchema = z.strictObject({
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  confirmation: z.literal('I_APPROVE_THIS_PLAN_ONLY'),
});
const noBodySchema = z.strictObject({}).optional();

function planState(plan: StoredPlan): WorktreePlanState {
  if (
    ['pending', 'acknowledged'].includes(plan.state) &&
    plan.expiresAt &&
    Date.parse(plan.expiresAt) <= Date.now()
  ) {
    return 'expired';
  }
  return plan.state;
}

function publicPlan(plan: StoredPlan): WorktreePlan {
  return { ...plan, state: planState(plan), history: plan.history.map((event) => ({ ...event })) };
}

function safeRepoFolder(repo: string): string {
  const folder = repo.split('/')[1];
  if (
    !folder ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(folder) ||
    folder === '.' ||
    folder === '..'
  ) {
    throw new BadRequestException('Недозволена назва локального репозиторію.');
  }
  return folder;
}

function gitOriginMatches(config: string, repository: string): boolean {
  // Only a trusted origin remote may select source code. Do not return URLs.
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inOrigin = section[1] === 'remote "origin"';
      continue;
    }
    if (!inOrigin) continue;
    const url = line.match(/^\s*url\s*=\s*(\S+)\s*$/)?.[1];
    if (!url) continue;
    const normalized = url
      .toLowerCase()
      .replace(/\.git\/?$/, '')
      .replace(/\/$/, '');
    const slug = repository.toLowerCase();
    return [
      `https://github.com/${slug}`,
      `git@github.com:${slug}`,
      `ssh://git@github.com/${slug}`,
    ].includes(normalized);
  }
  return false;
}

export async function verifyLocalRepository(
  repository: string,
  parentRoot: string,
): Promise<string> {
  const folder = safeRepoFolder(repository);
  if (!isAbsolute(parentRoot)) {
    throw new BadRequestException('Коренева папка репозиторіїв повинна мати абсолютний шлях.');
  }
  const parent = await realpath(parentRoot).catch(() => {
    throw new ServiceUnavailableException('Коренева папка репозиторіїв недоступна.');
  });
  const expected = resolve(parent, folder);
  const actual = await realpath(expected).catch(() => {
    throw new NotFoundException('Локальний репозиторій не знайдено.');
  });

  const normalizedRelative = relative(parent, actual);
  if (
    normalizedRelative.toLowerCase() !== folder.toLowerCase() ||
    normalizedRelative.startsWith('..') ||
    isAbsolute(normalizedRelative) ||
    basename(actual).toLowerCase() !== folder.toLowerCase()
  ) {
    throw new BadRequestException('Репозиторій знаходиться поза дозволеною папкою.');
  }

  const gitDir = join(actual, '.git');
  const stats = await lstat(gitDir).catch(() => {
    throw new BadRequestException('Це не основна папка Git-репозиторію.');
  });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new BadRequestException('Недозволений формат Git-репозиторію.');
  }
  const config = await readFile(join(gitDir, 'config'), 'utf8').catch(() => {
    throw new BadRequestException('Неможливо перевірити Git origin.');
  });
  if (!gitOriginMatches(config, repository)) {
    throw new BadRequestException('Git origin не відповідає вибраному репозиторію.');
  }
  return actual;
}

async function validateTargetRoot(root: string): Promise<string> {
  // This is only a plan, not a directory creation. Existing path components
  // must not be symlinks; we never make a worktree inside a redirected root.
  if (!isAbsolute(root)) throw new BadRequestException('Недозволений worktree root.');
  const absolute = resolve(root);
  for (const component of [dirname(absolute), absolute]) {
    const stat = await lstat(component).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new ServiceUnavailableException('Не вдалося перевірити шлях worktree.');
    });
    if (stat?.isSymbolicLink()) throw new BadRequestException('Символьні посилання заборонено.');
    if (stat && !stat.isDirectory()) throw new BadRequestException('Некоректна папка worktree.');
  }
  return absolute;
}

@Injectable()
export class WorktreePlanService {
  private readonly filePath = resolve(
    process.env.DEV_HUB_PLAN_FILE ?? resolve(process.cwd(), '.local', 'worktree-plans.json'),
  );
  private readonly reposRoot = resolve(
    process.env.DEV_HUB_REPOS_ROOT ?? resolve(process.cwd(), '..', '..', '..'),
  );
  private readonly worktreesRoot = resolve(
    process.env.DEV_HUB_WORKTREES_ROOT ?? resolve(process.cwd(), '.local', 'worktrees'),
  );
  private serialized: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly github: GitHubService,
  ) {}

  private async load(): Promise<Store> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, plans: [] };
      }
      throw new ServiceUnavailableException('Не вдалося прочитати маніфести worktree.');
    }
    try {
      return storeSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      throw new ServiceUnavailableException(
        'Файл маніфестів пошкоджено. Він не буде автоматично перезаписаний.',
      );
    }
  }

  private async save(store: Store): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(store, null, 2), {
        flag: 'wx',
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temp, this.filePath);
    } catch {
      await unlink(temp).catch(() => undefined);
      throw new ServiceUnavailableException('Не вдалося зберегти маніфест.');
    }
  }

  private transact<T>(callback: (store: Store) => T | Promise<T>, write = false): Promise<T> {
    const current = this.serialized.then(async () => {
      const store = await this.load();
      const result = await callback(store);
      if (write) await this.save(store);
      return result;
    });
    this.serialized = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private find(store: Store, sessionId: string, planId: string): StoredPlan {
    if (!uuidSchema.safeParse(planId).success)
      throw new BadRequestException('Некоректний ID плану.');
    const plan = store.plans.find((item) => item.id === planId && item.sessionId === sessionId);
    if (!plan) throw new NotFoundException('План worktree не знайдено.');
    return plan;
  }

  async list(sessionId: string): Promise<WorktreePlan[]> {
    await this.workspace.get(sessionId);
    return this.transact((store) =>
      store.plans
        .filter((item) => item.sessionId === sessionId)
        .map(publicPlan)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  async create(sessionId: string): Promise<WorktreePlan> {
    const session = await this.workspace.get(sessionId);
    if (session.status === 'completed') {
      throw new ConflictException('Не можна планувати worktree для завершеної сесії.');
    }
    const repository = this.github.assertAllowedRepository(session.repository);
    const sourcePath = await verifyLocalRepository(repository, this.reposRoot);
    const targetRoot = await validateTargetRoot(this.worktreesRoot);

    return this.transact(async (store) => {
      if (store.plans.length >= MAX_PLANS) {
        throw new BadRequestException('Ліміт 100 збережених планів.');
      }
      if (
        store.plans.some(
          (item) =>
            item.sessionId === sessionId &&
            ['pending', 'acknowledged', 'creating', 'created'].includes(planState(item)),
        )
      ) {
        throw new ConflictException('Для цієї сесії вже існує активний план.');
      }
      const id = randomUUID();
      const targetPath = join(targetRoot, id);
      if (relative(targetRoot, targetPath) !== id) {
        throw new BadRequestException('Некоректний шлях майбутнього worktree.');
      }
      const target = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw new ServiceUnavailableException('Не вдалося перевірити місце worktree.');
      });
      if (target) throw new ConflictException('Шлях майбутнього worktree зайнятий.');

      const proposedBranch = `devhub/task-${id.replace(/-/g, '')}`;
      const fingerprint =
        'sha256:' +
        createHash('sha256')
          .update(JSON.stringify({ sessionId, repository, sourcePath, targetPath, proposedBranch }))
          .digest('hex');
      const now = new Date().toISOString();
      const plan: StoredPlan = {
        id,
        sessionId,
        repository,
        sourcePath,
        targetPath,
        proposedBranch,
        fingerprint,
        state: 'pending',
        createdAt: now,
        expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
        history: [{ event: 'created', timestamp: now }],
        executionEnabled: false,
        worktreeCreated: false,
      };
      store.plans.push(plan);
      return publicPlan(plan);
    }, true);
  }

  async acknowledge(sessionId: string, planId: string, input: unknown): Promise<WorktreePlan> {
    const parsed = acknowledgeSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException('Підтверди конкретний fingerprint та фразу погодження.');
    }
    await this.workspace.get(sessionId);
    return this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (planState(plan) !== 'pending') {
        throw new ConflictException('План уже погоджено або відкликано.');
      }
      if (plan.fingerprint !== parsed.data.fingerprint) {
        throw new ConflictException('Маніфест змінився. Потрібне нове погодження.');
      }
      const now = new Date();
      plan.state = 'acknowledged';
      plan.expiresAt = new Date(now.getTime() + PLAN_TTL_MS).toISOString();
      plan.history.push({ event: 'acknowledged', timestamp: now.toISOString() });
      return publicPlan(plan);
    }, true);
  }

  async approvedPlan(sessionId: string, planId: string): Promise<WorktreePlan> {
    const session = await this.workspace.get(sessionId);
    if (session.status === 'completed') {
      throw new ConflictException('Завершена сесія не може створювати worktree.');
    }
    return this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (planState(plan) !== 'acknowledged' || plan.worktreeCreated) {
        throw new ConflictException('Спочатку погодь непрострочений план.');
      }
      if (
        !this.github.listAllowedRepositories().includes(plan.repository) ||
        plan.repository !== session.repository
      ) {
        throw new ConflictException('Репозиторій плану більше не дозволений.');
      }
      return publicPlan(plan);
    });
  }

  async reserveCreation(
    sessionId: string,
    planId: string,
    fingerprint: string,
    baseHeadSha: string,
  ): Promise<WorktreePlan> {
    // Every request is serialized and state is persisted before invoking Git.
    const session = await this.workspace.get(sessionId);
    if (session.status === 'completed') {
      throw new ConflictException('Завершена сесія не може створювати worktree.');
    }
    return this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (
        planState(plan) !== 'acknowledged' ||
        plan.worktreeCreated ||
        plan.fingerprint !== fingerprint ||
        plan.repository !== session.repository ||
        !this.github.listAllowedRepositories().includes(plan.repository)
      ) {
        throw new ConflictException('Погодження недійсне або вже використане.');
      }
      if (!/^[0-9a-f]{40,64}$/.test(baseHeadSha)) {
        throw new BadRequestException('Некоректний Git commit.');
      }
      plan.state = 'creating';
      plan.baseHeadSha = baseHeadSha;
      plan.expiresAt = null;
      plan.history.push({ event: 'creation-started', timestamp: new Date().toISOString() });
      return publicPlan(plan);
    }, true);
  }

  async finishCreation(
    sessionId: string,
    planId: string,
    result: 'created' | 'failed',
  ): Promise<WorktreePlan> {
    return this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (plan.state !== 'creating') {
        throw new ConflictException('Стан роботи змінився, неможливо завершити створення.');
      }
      plan.state = result;
      plan.worktreeCreated = result === 'created';
      plan.history.push({
        event: result === 'created' ? 'worktree-created' : 'creation-failed',
        timestamp: new Date().toISOString(),
      });
      return publicPlan(plan);
    }, true);
  }

  async availableForHydration(sessionId: string, planId: string): Promise<WorktreePlan> {
    const session = await this.workspace.get(sessionId);
    if (session.status === 'completed') {
      throw new ConflictException('Не можна змінювати worktree завершеної сесії.');
    }
    return this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (
        plan.state !== 'created' ||
        !plan.worktreeCreated ||
        plan.hydrationState ||
        plan.repository !== session.repository ||
        !this.github.listAllowedRepositories().includes(plan.repository)
      ) {
        throw new ConflictException('Worktree уже наповнений, змінений або недоступний.');
      }
      return publicPlan(plan);
    });
  }

  async reserveHydration(
    sessionId: string,
    planId: string,
    fingerprint: string,
    commit: string,
  ): Promise<WorktreePlan> {
    const session = await this.workspace.get(sessionId);
    if (session.status === 'completed') {
      throw new ConflictException('Не можна змінювати worktree завершеної сесії.');
    }
    return this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (
        plan.state !== 'created' ||
        !plan.worktreeCreated ||
        plan.hydrationState ||
        plan.fingerprint !== fingerprint ||
        plan.baseHeadSha !== commit ||
        plan.repository !== session.repository ||
        !this.github.listAllowedRepositories().includes(plan.repository)
      ) {
        throw new ConflictException('Hydration уже почато або дозвіл більше не чинний.');
      }
      plan.hydrationState = 'running';
      plan.hydrationFiles = 0;
      plan.hydrationBytes = 0;
      plan.history.push({ event: 'hydration-started', timestamp: new Date().toISOString() });
      return publicPlan(plan);
    }, true);
  }

  async recordHydrationProgress(
    sessionId: string,
    planId: string,
    files: number,
    bytes: number,
  ): Promise<void> {
    await this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (
        plan.hydrationState !== 'running' ||
        !Number.isSafeInteger(files) ||
        !Number.isSafeInteger(bytes) ||
        files < (plan.hydrationFiles ?? 0) ||
        bytes < (plan.hydrationBytes ?? 0) ||
        files > 5000 ||
        bytes > 100 * 1024 * 1024
      ) {
        throw new ConflictException('Непослідовний стан hydration.');
      }
      plan.hydrationFiles = files;
      plan.hydrationBytes = bytes;
    }, true);
  }

  async finishHydration(
    sessionId: string,
    planId: string,
    outcome: 'completed' | 'failed',
    files?: number,
    bytes?: number,
  ): Promise<WorktreePlan> {
    return this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (plan.hydrationState !== 'running') {
        throw new ConflictException('Hydration не перебуває у стані виконання.');
      }
      if (outcome === 'completed') {
        if (
          !Number.isSafeInteger(files) ||
          !Number.isSafeInteger(bytes) ||
          files! < (plan.hydrationFiles ?? 0) ||
          bytes! < (plan.hydrationBytes ?? 0) ||
          files! > 5000 ||
          bytes! > 100 * 1024 * 1024
        ) {
          throw new ConflictException('Некоректний результат hydration.');
        }
        plan.hydrationFiles = files;
        plan.hydrationBytes = bytes;
      }
      plan.hydrationState = outcome;
      plan.history.push({
        event: outcome === 'completed' ? 'hydration-completed' : 'hydration-failed',
        timestamp: new Date().toISOString(),
      });
      return publicPlan(plan);
    }, true);
  }

  async availableForMountProbe(sessionId: string, planId: string): Promise<WorktreePlan> {
    const session = await this.workspace.get(sessionId);
    if (session.status === 'completed') {
      throw new ConflictException('Не можна використовувати worktree завершеної сесії.');
    }
    return this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (
        plan.state !== 'created' ||
        !plan.worktreeCreated ||
        plan.hydrationState !== 'completed' ||
        plan.repository !== session.repository ||
        !this.github.listAllowedRepositories().includes(plan.repository)
      ) {
        throw new ConflictException('Worktree не завершено або репозиторій більше не дозволено.');
      }
      return publicPlan(plan);
    });
  }

  async recordMountProbe(
    sessionId: string,
    planId: string,
    step: 'started' | 'verified' | 'failed',
  ): Promise<void> {
    await this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (plan.state !== 'created' || plan.hydrationState !== 'completed') {
        throw new ConflictException('План не готовий до запису журналу Docker mount.');
      }
      if (plan.history.length >= 250) {
        throw new ConflictException('Ліміт записів аудиту, створюй нову сесію.');
      }
      plan.history.push({
        event:
          step === 'started'
            ? 'mount-probe-started'
            : step === 'verified'
              ? 'mount-probe-verified'
              : 'mount-probe-failed',
        timestamp: new Date().toISOString(),
      });
    }, true);
  }

  async revoke(sessionId: string, planId: string, input: unknown): Promise<WorktreePlan> {
    if (!noBodySchema.safeParse(input).success) {
      throw new BadRequestException('Некоректний запит відкликання.');
    }
    await this.workspace.get(sessionId);
    return this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (!['pending', 'acknowledged'].includes(planState(plan)))
        throw new ConflictException('План не можна відкликати.');
      plan.state = 'revoked';
      plan.expiresAt = null;
      plan.history.push({ event: 'revoked', timestamp: new Date().toISOString() });
      return publicPlan(plan);
    }, true);
  }
  async recordCodeRead(
    sessionId: string,
    planId: string,
    step: 'started' | 'completed' | 'failed',
  ): Promise<void> {
    await this.transact((store) => {
      const plan = this.find(store, sessionId, planId);
      if (plan.state !== 'created' || plan.hydrationState !== 'completed') {
        throw new ConflictException('План не готовий до аудиту code read.');
      }
      if (plan.history.length >= 250) {
        throw new ConflictException('Ліміт записів аудиту, створюй нову сесію.');
      }
      plan.history.push({
        event:
          step === 'started'
            ? 'code-read-started'
            : step === 'completed'
              ? 'code-read-completed'
              : 'code-read-failed',
        timestamp: new Date().toISOString(),
      });
    }, true);
  }

}
