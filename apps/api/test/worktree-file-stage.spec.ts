import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WorktreePlan } from '@gym-dev-hub/contracts';
import { withPinnedFileStage } from '../src/worktree/worktree-file-stage.js';

describe('single-use pinned Git blob staging for non-root Docker', () => {
  let root: string;
  let plan: WorktreePlan;
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'devhub-pinned-stage-'));
    await mkdir(join(root, 'src'));
    file = join(root, 'src', 'sample.ts');
    await writeFile(file, 'export const pinned = 1;\n', { mode: 0o600 });
    await chmod(file, 0o600);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 12_000 }).trim();
    git('init', '--quiet');
    git('add', '--', 'src/sample.ts');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD');
    plan = {
      id: '00000000-0000-4000-8000-000000000123',
      sessionId: '00000000-0000-4000-8000-000000000456',
      repository: 'sauron9521/gym-platform',
      sourcePath: root,
      targetPath: root,
      proposedBranch: 'devhub/test',
      fingerprint: 'sha256:' + 'b'.repeat(64),
      state: 'created',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      history: [],
      worktreeCreated: true,
      executionEnabled: false,
      hydrationState: 'completed',
      baseHeadSha: commit,
    };
    process.env.DEV_HUB_ENABLE_PINNED_FILE_STAGE = 'true';
  });

  afterEach(async () => {
    delete process.env.DEV_HUB_ENABLE_PINNED_FILE_STAGE;
    await rm(root, { recursive: true, force: true });
  });

  it('stages precisely one blob, accessible to UID 65534, without changing source mode', async () => {
    const before = await lstat(file);
    const result = await withPinnedFileStage(plan, 'src/sample.ts', async (stage) => {
      expect(stage.fileName).toBe('sample.ts');
      expect(stage.sourcePath).not.toBe(root);
      expect(dirname(stage.sourcePath)).toBe(dirname(root));
      expect(await readdir(stage.sourcePath)).toEqual(['sample.ts']);
      expect(stage.bytes.toString('utf8')).toBe('export const pinned = 1;\n');
      expect(await readFile(join(stage.sourcePath, stage.fileName), 'utf8')).toBe('export const pinned = 1;\n');
      expect(stage.sha256).toBe(createHash('sha256').update(stage.bytes).digest('hex'));
      const stageDirStat = await lstat(stage.sourcePath);
      const stagedFileStat = await lstat(join(stage.sourcePath, stage.fileName));
      if (process.platform !== 'win32') {
        expect(stageDirStat.mode & 0o777).toBe(0o711);
        expect(stagedFileStat.mode & 0o777).toBe(0o644);
      }
      return { stagedRoot: stage.sourcePath, digest: stage.sha256 };
    });
    const after = await lstat(file);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(await readFile(file, 'utf8')).toBe('export const pinned = 1;\n');
    await expect(lstat(result.stagedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('always removes its own staged file and directory if the worker fails', async () => {
    let stagedRoot = '';
    await expect(
      withPinnedFileStage(plan, 'src/sample.ts', async (stage) => {
        stagedRoot = stage.sourcePath;
        throw new Error('Docker refused mount');
      }),
    ).rejects.toThrow('Docker refused mount');
    await expect(lstat(stagedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(file, 'utf8')).toBe('export const pinned = 1;\n');
  });

  it('stages the immutable pinned blob even if the original is concurrently modified', async () => {
    await writeFile(file, 'export const pinned = 2;\n');
    const data = await withPinnedFileStage(plan, 'src/sample.ts', async (stage) => stage.bytes.toString('utf8'));
    expect(data).toBe('export const pinned = 1;\n');
  });

  it('rejects missing opt-in, traversal and oversized sources', async () => {
    delete process.env.DEV_HUB_ENABLE_PINNED_FILE_STAGE;
    await expect(withPinnedFileStage(plan, 'src/sample.ts', async () => 1)).rejects.toThrow('not enabled');
    process.env.DEV_HUB_ENABLE_PINNED_FILE_STAGE = 'true';
    await expect(withPinnedFileStage(plan, '../sample.ts', async () => 1)).rejects.toThrow();
    await expect(withPinnedFileStage(plan, '.git/config.json', async () => 1)).rejects.toThrow();
    await writeFile(join(root, 'src', 'oversized.ts'), 'x'.repeat(8193));
    await expect(withPinnedFileStage(plan, 'src/oversized.ts', async () => 1)).rejects.toThrow();
  });
});
