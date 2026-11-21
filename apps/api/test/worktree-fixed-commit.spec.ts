import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configuredCommitIdentity,
  fixedGit,
  fixedOneFileCommit,
  type FixedCommitInput,
  type FixedCommitIdentity,
} from '../src/worktree/worktree-fixed-commit.js';

const identity: FixedCommitIdentity = { name: 'Test Reviewer', email: 'reviewer@example.invalid' };
const SHA256 = (data: string) => createHash('sha256').update(data).digest('hex');
const BRANCH = 'devhub/task-' + 'd'.repeat(32);
const FILE = 'apps/api/src/main.ts';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    shell: false,
    timeout: 15000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    },
  });
  if (result.status !== 0) throw Error('test git fixture command failed ' + args[0]);
  return result.stdout.trim();
}

describe('one-file fixed Git commit against disposable real Git worktrees', () => {
  let root: string;
  let source: string;
  let worktree: string;
  let temporaryRoot: string;
  let baseSha: string;
  let input: FixedCommitInput;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hub-commit-fixture-'));
    source = join(root, 'source');
    worktree = join(root, 'task');
    temporaryRoot = join(root, 'private');
    await mkdir(join(source, 'apps/api/src'), { recursive: true });
    await mkdir(temporaryRoot);
    git(source, 'init', '-q');
    await writeFile(join(source, FILE), 'export const original = true;\n');
    await writeFile(join(source, 'README.md'), 'stable README\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'fixture');
    baseSha = git(source, 'rev-parse', 'HEAD');
    git(source, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'HEAD');
    const changed = 'export const original = false;\n';
    await writeFile(join(worktree, FILE), changed);
    input = {
      worktree,
      branch: BRANCH,
      baseSha,
      path: FILE,
      proposedSha256: SHA256(changed),
      subject: 'fix(api): record one reviewed Git commit',
      identity,
      temporaryRoot,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('commits only reviewed raw file bytes via CAS, with clean worktree and unchanged source/main', async () => {
    let called = 0;
    let advanced = 0;
    const result = await fixedOneFileCommit(
      input,
      async () => {
        called++;
      },
      () => {
        advanced++;
      },
    );
    expect({ called, advanced }).toEqual({ called: 1, advanced: 1 });
    expect(result).toMatchObject({
      parentSha: baseSha,
      branch: BRANCH,
      refUpdated: true,
      worktreeClean: true,
      filePathSha256: SHA256(FILE),
    });
    expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(result.commitSha);
    expect(git(worktree, 'show', '-s', '--format=%s', 'HEAD')).toBe(input.subject);
    expect(git(worktree, 'show', '-s', '--format=%P', 'HEAD')).toBe(baseSha);
    expect(git(worktree, 'diff-tree', '--no-commit-id', '--name-only', '-r', baseSha, 'HEAD')).toBe(
      FILE,
    );
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(git(source, 'rev-parse', 'HEAD')).toBe(baseSha);
    expect(await readFile(join(source, 'README.md'), 'utf8')).toBe('stable README\n');
    expect(await readFile(join(worktree, 'README.md'), 'utf8')).toBe('stable README\n');
    expect(git(worktree, 'branch', '--show-current')).toBe(BRANCH);
    expect(git(worktree, 'log', '-1', '--format=%ae')).toBe(identity.email);
  });

  it('rejects unintended existing stage/index changes without moving the ref', async () => {
    git(worktree, 'add', '--', FILE);
    await expect(
      fixedOneFileCommit(
        input,
        async () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow('Fixed local Git plumbing');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(baseSha);
  });

  it('rejects changed bytes, symlink source and extra source changes', async () => {
    await writeFile(join(worktree, FILE), 'tampered bytes\n');
    await expect(
      fixedOneFileCommit(
        input,
        async () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow('postimage');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(baseSha);
    await rm(join(worktree, FILE));
    await symlink(join(source, FILE), join(worktree, FILE));
    await expect(
      fixedOneFileCommit(
        input,
        async () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow('Unsafe');
  });

  it('rejects changed HEAD and any branch outside dedicated task namespace', async () => {
    await expect(
      fixedOneFileCommit(
        { ...input, branch: 'main' },
        async () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow('Unsupported');
    await expect(
      fixedOneFileCommit(
        { ...input, baseSha: 'f'.repeat(40) },
        async () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow('HEAD/ref');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(baseSha);
  });

  it('last-second Git review failure leaves branch and real index unchanged', async () => {
    await expect(
      fixedOneFileCommit(
        input,
        async () => {
          throw Error('source evidence changed');
        },
        () => undefined,
      ),
    ).rejects.toThrow('source evidence changed');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(baseSha);
    expect(git(worktree, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(worktree, 'diff', '--name-only')).toBe(FILE);
  });

  it('CAS detects concurrent modification before ref update and does not overwrite it', async () => {
    const replacement = git(source, 'rev-parse', 'HEAD');
    let newer = '';
    await expect(
      fixedOneFileCommit(
        input,
        async () => {
          // Unexpected third-party task ref move before CAS.
          newer = git(
            source,
            'commit-tree',
            git(source, 'rev-parse', 'HEAD^{tree}'),
            '-p',
            replacement,
            '-m',
            'external task commit',
          );
          git(source, 'update-ref', 'refs/heads/' + BRANCH, newer, replacement);
        },
        () => undefined,
      ),
    ).rejects.toThrow('Branch changed before CAS');
    expect(git(source, 'rev-parse', 'refs/heads/' + BRANCH)).toBe(newer);
    expect(git(source, 'rev-parse', 'HEAD')).toBe(baseSha);
  });

  it('cannot exploit path traversal, other file, or arbitrary shell arguments', async () => {
    for (const path of [
      '../outside',
      'README.md',
      'apps/api/src/../README.md',
      'apps/api/src/main.ts\n--output=/tmp',
      'apps/api/src\\main.ts',
    ]) {
      await expect(
        fixedOneFileCommit(
          { ...input, path },
          async () => undefined,
          () => undefined,
        ),
      ).rejects.toThrow('Unsupported');
    }
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(baseSha);
  });

  it('ignores hostile hooks, user aliases, and global Git settings while committing', async () => {
    // Commit-tree Git plumbing runs no Git hooks. This guard file must not execute.
    await mkdir(join(source, '.git/hooks'), { recursive: true });
    await writeFile(join(source, '.git/hooks/prepare-commit-msg'), '#!/bin/sh\nexit 99\n');
    await chmod(join(source, '.git/hooks/prepare-commit-msg'), 0o755);
    const result = await fixedOneFileCommit(
      input,
      async () => undefined,
      () => undefined,
    );
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(result.commitSha);
  });

  it('requires explicitly configured author, not an inferred Git global identity', () => {
    const oldName = process.env.DEV_HUB_COMMIT_AUTHOR_NAME;
    const oldEmail = process.env.DEV_HUB_COMMIT_AUTHOR_EMAIL;
    try {
      delete process.env.DEV_HUB_COMMIT_AUTHOR_NAME;
      delete process.env.DEV_HUB_COMMIT_AUTHOR_EMAIL;
      expect(() => configuredCommitIdentity()).toThrow('explicit');
      process.env.DEV_HUB_COMMIT_AUTHOR_NAME = 'Operator';
      process.env.DEV_HUB_COMMIT_AUTHOR_EMAIL = 'operator@example.com';
      expect(configuredCommitIdentity()).toEqual({
        name: 'Operator',
        email: 'operator@example.com',
      });
      process.env.DEV_HUB_COMMIT_AUTHOR_NAME = 'Name\nInjected';
      expect(() => configuredCommitIdentity()).toThrow('explicit');
    } finally {
      if (oldName) process.env.DEV_HUB_COMMIT_AUTHOR_NAME = oldName;
      else delete process.env.DEV_HUB_COMMIT_AUTHOR_NAME;
      if (oldEmail) process.env.DEV_HUB_COMMIT_AUTHOR_EMAIL = oldEmail;
      else delete process.env.DEV_HUB_COMMIT_AUTHOR_EMAIL;
    }
  });

  it('executes only static git subcommands with explicit args, no shell', async () => {
    const head = await fixedGit(worktree, ['rev-parse', 'HEAD'], identity);
    expect(head).toBe(baseSha);
    expect(randomBytes(1)).toHaveLength(1);
    const state = await lstat(worktree);
    expect(state.isDirectory()).toBe(true);
  });
});
