import { ConflictException, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, join } from 'node:path';
import type { WorktreeInspection, WorktreePlan } from '@gym-dev-hub/contracts';
import { verifyLocalRepository } from './worktree-plan.service.js';

const MAX_FILES = 5_000;
const MAX_TREE_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SHA = /^[0-9a-f]{40,64}$/;
const FORBIDDEN = /[<>:"\\|?*]/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export interface TreeSummary {
  fileCount: number;
  totalBytes: number;
  violations: string[];
}

/** Parses Git's NUL-terminated ls-tree metadata, never evaluating repository content. */
export function inspectTreeListing(listing: string): TreeSummary {
  const violations: string[] = [];
  const files = new Set<string>();
  const directories = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;

  if (listing && !listing.endsWith('\0')) {
    return { fileCount: 0, totalBytes: 0, violations: ['Неповний вивід Git tree.'] };
  }

  for (const line of listing.split('\0')) {
    if (!line) continue;
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40,64}) +([0-9]+|-)\t(.+)$/s.exec(line);
    if (!match) {
      violations.push('Некоректний запис Git tree.');
      continue;
    }
    const [, mode, kind, , sizeText, name] = match;
    fileCount++;
    if (fileCount > MAX_FILES) {
      violations.push('Перевищено ліміт файлів для контрольованого checkout.');
      break;
    }
    const size = Number(sizeText);
    if (
      kind !== 'blob' ||
      !['100644', '100755'].includes(mode!) ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      violations.push('Непідтримуваний об’єкт Git: symlink, submodule або special mode.');
      continue;
    }
    totalBytes += size;
    if (size > MAX_FILE_BYTES || totalBytes > MAX_TREE_BYTES) {
      violations.push('Перевищено ліміт розміру Git tree.');
    }

    if (!name || name.includes('\uFFFD') || name.startsWith('/') || name.includes('\\')) {
      violations.push('Недопустима назва файлу.');
      continue;
    }
    const parts = name.split('/');
    if (
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase() === '.git' ||
          part.endsWith('.') ||
          part.endsWith(' ') ||
          FORBIDDEN.test(part) ||
          [...part].some((character) => character.charCodeAt(0) < 32) ||
          WINDOWS_DEVICE.test(part),
      )
    ) {
      violations.push('Недозволений компонент шляху для Windows/Linux.');
      continue;
    }
    const key = name.normalize('NFKC').toLowerCase();
    if (files.has(key) || directories.has(key)) {
      violations.push('Конфлікт шляхів у Git tree (регістр або Unicode).');
    }
    files.add(key);
    let prefix = '';
    for (const part of parts.slice(0, -1)) {
      prefix = prefix ? prefix + '/' + part : part;
      const normalized = prefix.normalize('NFKC').toLowerCase();
      if (files.has(normalized)) {
        violations.push('Файл конфліктує з батьківською папкою.');
      }
      directories.add(normalized);
    }
  }
  return {
    fileCount,
    totalBytes,
    violations: [...new Set(violations)].slice(0, 8),
  };
}

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
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function gitRead(cwd: string, args: string[]): Promise<string> {
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
        env: gitEnvironment(),
        windowsHide: true,
        shell: false,
        timeout: 12_000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, output) => {
        if (error) reject(new Error('Git read-only inspection failed'));
        else resolveOutput(output.trim());
      },
    );
  });
}

async function verifyRoot(target: string, root: string): Promise<void> {
  if (!isAbsolute(root)) throw new Error('Invalid root');
  let current = resolve(root);
  while (true) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Redirected worktree root');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const canonical = await realpath(root);
  if (resolve(canonical).toLowerCase() !== resolve(root).toLowerCase()) {
    throw new Error('Worktree root changed');
  }
  if (resolve(target) !== resolve(root, target.split(/[\\/]/).at(-1) ?? '')) {
    throw new Error('Target outside worktree root');
  }
}

@Injectable()
export class WorktreeInspectionService {
  private readonly reposRoot = resolve(
    process.env.DEV_HUB_REPOS_ROOT ?? resolve(process.cwd(), '..', '..', '..'),
  );
  private readonly worktreesRoot = resolve(
    process.env.DEV_HUB_WORKTREES_ROOT ?? resolve(process.cwd(), '.local', 'worktrees'),
  );

  async inspect(plan: WorktreePlan): Promise<WorktreeInspection> {
    if (!['creating', 'created', 'failed'].includes(plan.state)) {
      throw new ConflictException('Потрібен план після створення Git worktree.');
    }
    const findings: string[] = [];
    let fileCount = 0;
    let totalBytes = 0;
    let targetExists = false;
    let metadataOnly = false;
    let stage = 'repository';

    try {
      const source = await verifyLocalRepository(plan.repository, this.reposRoot);
      if (resolve(source).toLowerCase() !== resolve(plan.sourcePath).toLowerCase()) {
        throw new Error('Source path drift');
      }
      if (
        plan.targetPath !== resolve(this.worktreesRoot, plan.id) ||
        relative(this.worktreesRoot, plan.targetPath) !== plan.id
      ) {
        throw new Error('Target path drift');
      }
      stage = 'worktree-root';
      await verifyRoot(plan.targetPath, this.worktreesRoot);
      const targetStat = await lstat(plan.targetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!targetStat) {
        findings.push('Папку worktree не знайдено.');
      } else {
        targetExists = true;
        if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
          throw new Error('Target symlink');
        }
        const dotGit = await lstat(join(plan.targetPath, '.git'));
        if (!dotGit.isFile() || dotGit.isSymbolicLink()) throw new Error('Invalid .git pointer');
        const entries = await readdir(plan.targetPath);
        metadataOnly = entries.length === 1 && entries[0] === '.git';
        if (!metadataOnly) findings.push('У worktree вже є файли: потрібна ручна перевірка.');

        stage = 'git-registration';
        const topLevel = await gitRead(plan.targetPath, ['rev-parse', '--show-toplevel']);
        const commonDir = await gitRead(plan.targetPath, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ]);
        if (
          (await realpath(topLevel)).toLowerCase() !==
            (await realpath(plan.targetPath)).toLowerCase() ||
          (await realpath(commonDir)).toLowerCase() !==
            (await realpath(join(source, '.git'))).toLowerCase()
        ) {
          findings.push('Git worktree прив’язаний до іншого репозиторію.');
        }
        const branch = await gitRead(plan.targetPath, ['symbolic-ref', '--quiet', 'HEAD']);
        const sha = await gitRead(plan.targetPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
        if (
          branch.trim() !== 'refs/heads/' + plan.proposedBranch ||
          !SHA.test(sha.trim()) ||
          sha.trim() !== plan.baseHeadSha
        ) {
          findings.push('Git branch або commit не відповідає маніфесту.');
        }
      }
      if (!plan.baseHeadSha || !SHA.test(plan.baseHeadSha)) {
        findings.push('Немає зафіксованого Git commit.');
      } else {
        stage = 'git-tree';
        const listing = await gitRead(source, [
          'ls-tree',
          '-r',
          '-l',
          '-z',
          '--full-tree',
          plan.baseHeadSha,
        ]);
        const summary = inspectTreeListing(listing);
        fileCount = summary.fileCount;
        totalBytes = summary.totalBytes;
        findings.push(...summary.violations);
      }
    } catch {
      findings.push(
        `Не вдалося завершити read-only перевірку (етап: ${stage}). Потрібна ручна перевірка.`,
      );
    }

    if (plan.state !== 'created' || !plan.worktreeCreated) {
      findings.push('Операція створення раніше завершилася неуспішно або була перервана.');
    }
    const state =
      findings.length === 0 ? 'ready-for-hydration' : targetExists ? 'needs-review' : 'missing';
    return {
      planId: plan.id,
      sessionId: plan.sessionId,
      state,
      targetExists,
      metadataOnly,
      fileCount,
      totalBytes,
      findings: [...new Set(findings)].slice(0, 10),
      checkedAt: new Date().toISOString(),
      hydrationEnabled: false,
      recoveryIsReadOnly: true,
    };
  }
}
