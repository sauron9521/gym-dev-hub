import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { WorktreePlan } from '@gym-dev-hub/contracts';
import { verifyLocalRepository } from './worktree-plan.service.js';

const SHA = /^[0-9a-f]{40,64}$/;
const BRANCH = /^devhub\/task-[0-9a-f]{32}$/;

function gitEnvironment(): NodeJS.ProcessEnv {
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
  // Ignore any process-level Git overrides, global hooks and credential prompts.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_LFS_SKIP_SMUDGE = '1';
  return env;
}

function gitExec(source: string, args: string[], timeoutMs = 12_000): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      'git',
      [
        '-c',
        'core.hooksPath=.gym-dev-hub-hooks-disabled',
        '-c',
        'core.fsmonitor=false',
        '-C',
        source,
        ...args,
      ],
      {
        windowsHide: true,
        shell: false,
        env: gitEnvironment(),
        timeout: timeoutMs,
        maxBuffer: 32 * 1024,
      },
      (error, stdout) => {
        if (error) {
          fail(new ServiceUnavailableException('Не вдалося виконати перевірену Git-операцію.'));
          return;
        }
        done(stdout.trim());
      },
    );
  });
}

async function mustNotExist(path: string): Promise<void> {
  const state = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw new ServiceUnavailableException('Не вдалося перевірити місце worktree.');
  });
  if (state) throw new ConflictException('Папка worktree вже існує. Операцію зупинено.');
}

async function secureTarget(plan: WorktreePlan, rootInput: string): Promise<void> {
  if (!isAbsolute(rootInput)) throw new ConflictException('Worktree root має бути абсолютним.');
  const root = resolve(rootInput);
  if (plan.targetPath !== resolve(root, plan.id) || relative(root, plan.targetPath) !== plan.id) {
    throw new ConflictException('План worktree вказує поза дозволеним root.');
  }
  // All existing ancestors of the root must be real directories, not symlinks or junctions.
  let path = root;
  while (true) {
    const state = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new ConflictException('Не вдалося перевірити шлях worktree.');
    });
    if (state && (!state.isDirectory() || state.isSymbolicLink())) {
      throw new ConflictException('Недозволене посилання або файл у шляху worktree.');
    }
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  await mkdir(root, { recursive: true });
  // Windows may return an 8.3 alias for the same safe directory. Reparse
  // points were already rejected for every existing ancestor above.
  await realpath(root);
  await mustNotExist(plan.targetPath);
}

@Injectable()
export class WorktreeGitService {
  private readonly reposRoot = resolve(
    process.env.DEV_HUB_REPOS_ROOT ?? resolve(process.cwd(), '..', '..', '..'),
  );
  private readonly targetRoot = resolve(
    process.env.DEV_HUB_WORKTREES_ROOT ?? resolve(process.cwd(), '.local', 'worktrees'),
  );

  async headSha(plan: Pick<WorktreePlan, 'repository' | 'sourcePath'>): Promise<string> {
    const source = await verifyLocalRepository(plan.repository, this.reposRoot);
    if (
      (await realpath(source)).toLowerCase() !== (await realpath(plan.sourcePath)).toLowerCase()
    ) {
      throw new ConflictException('Локальний репозиторій відрізняється від плану.');
    }
    const sha = await gitExec(source, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!SHA.test(sha)) throw new ConflictException('Git HEAD не є валідним commit.');
    return sha;
  }

  async createMetadataWorktree(plan: WorktreePlan, boundSha: string): Promise<void> {
    if (!BRANCH.test(plan.proposedBranch) || !SHA.test(boundSha)) {
      throw new ConflictException('Git branch або SHA невалідні.');
    }
    if ((await this.headSha(plan)) !== boundSha) {
      throw new ConflictException('Git HEAD змінився після погодження. Створи новий дозвіл.');
    }
    await secureTarget(plan, this.targetRoot);
    // Prevent branch reuse. No shell command strings are accepted from the UI.
    const source = plan.sourcePath;
    const refs = await gitExec(source, [
      'for-each-ref',
      '--format=%(refname)',
      `refs/heads/${plan.proposedBranch}`,
    ]);
    if (refs) throw new ConflictException('Запланована Git-гілка вже існує.');
    await gitExec(
      source,
      [
        'worktree',
        'add',
        '--no-checkout',
        '-b',
        plan.proposedBranch,
        '--',
        plan.targetPath,
        boundSha,
      ],
      25_000,
    );
    const createdSha = await gitExec(plan.targetPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (createdSha !== boundSha) {
      throw new ConflictException('Створений Git worktree вказує на інший коміт.');
    }
  }
}
