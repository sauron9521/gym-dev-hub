import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withPatchCheckSourceStage } from '../src/worktree/worktree-patch-check-stage.js';

describe('isolated patch-check source snapshot', () => {
  let root: string;
  let source: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'devhub-check-stage-test-'));
    source = join(root, 'worktree');
    await mkdir(join(source, 'apps/web/src'), { recursive: true });
    await writeFile(join(source, '.git'), 'gitdir: separate metadata\n', { mode: 0o600 });
    await writeFile(join(source, 'apps/web/src/file.ts'), 'export const safe = true;\n', {
      mode: 0o600,
    });
    await writeFile(join(source, 'package.json'), '{"private":true}\n', { mode: 0o600 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies source for UID 65534 without chmod on the original and cleans up', async () => {
    const original = join(source, 'apps/web/src/file.ts');
    const originalMode = (await lstat(original)).mode & 0o777;
    if (process.platform !== 'win32') expect(originalMode).toBe(0o600);
    let tempPath = '';

    await withPatchCheckSourceStage(source, async (staged) => {
      tempPath = staged;
      expect(staged).not.toBe(source);
      if (process.platform !== 'win32') {
        expect((await lstat(staged)).mode & 0o777).toBe(0o755);
        expect((await lstat(join(staged, 'apps/web/src/file.ts'))).mode & 0o777).toBe(0o644);
        expect((await lstat(join(staged, 'apps'))).mode & 0o777).toBe(0o755);
      }
      expect(await readFile(join(staged, 'apps/web/src/file.ts'), 'utf8')).toBe(
        'export const safe = true;\n',
      );
      expect(await readdir(staged)).toEqual(['apps', 'package.json']);
      expect((await lstat(original)).mode & 0o777).toBe(originalMode);
    });

    expect(await readdir(root)).toEqual(['worktree']);
    await expect(lstat(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    if (process.platform !== 'win32') expect((await lstat(original)).mode & 0o777).toBe(0o600);
  });

  it('removes the exact staged files even if the fixed runner rejects', async () => {
    await expect(
      withPatchCheckSourceStage(source, async () => {
        throw new Error('fixed runner failed');
      }),
    ).rejects.toThrow('fixed runner failed');
    expect(await readdir(root)).toEqual(['worktree']);
    expect(await readFile(join(source, 'apps/web/src/file.ts'), 'utf8')).toBe(
      'export const safe = true;\n',
    );
  });

  it('refuses symlinks and leaves no staged files behind', async () => {
    await symlink(join(source, 'package.json'), join(source, 'apps/web/src/redirect.ts'));
    await expect(withPatchCheckSourceStage(source, async () => undefined)).rejects.toThrow(
      'Symlinks are forbidden',
    );
    expect(await readdir(root)).toEqual(['worktree']);
  });

  it('rejects an oversized file without broadening source permissions', async () => {
    const badFile = join(source, 'apps/web/src/file.ts');
    await writeFile(badFile, Buffer.alloc(20 * 1024 * 1024 + 1));
    await chmod(badFile, 0o600);
    await expect(withPatchCheckSourceStage(source, async () => undefined)).rejects.toThrow(
      'exceeds its source size limit',
    );
    if (process.platform !== 'win32') expect((await lstat(badFile)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(['worktree']);
  });
});
