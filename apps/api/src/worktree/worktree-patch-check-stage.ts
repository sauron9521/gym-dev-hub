import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const MAX_FILES = 5_000;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Temporarily expose the verified worktree to the non-root Docker UID without
 * modifying the 0600 hydrated originals. Only a fresh sibling snapshot is
 * made readable, and it is removed before the authorized check returns.
 * The caller must verify the full pinned worktree before and after staging.
 */
export async function withPatchCheckSourceStage<T>(
  worktree: string,
  action: (sourcePath: string) => Promise<T>,
): Promise<T> {
  const root = await realpath(worktree);
  const rootStat = await lstat(worktree);
  if (root !== resolve(worktree) || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Patch check source must be a canonical directory');
  }

  const stageRoot = await mkdtemp(join(dirname(root), '.gym-dev-hub-check-stage-'));
  const files: string[] = [];
  const folders: string[] = [];
  let fileCount = 0;
  let byteCount = 0;

  async function copy(source: string, dest: string, level: number): Promise<void> {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name === '.git') {
        if (level === 0) continue;
        throw new Error('Nested Git metadata is forbidden in the patch snapshot');
      }
      const from = join(source, entry.name);
      const to = join(dest, entry.name);
      const stat = await lstat(from);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are forbidden in the patch snapshot');
      if (stat.isDirectory()) {
        await mkdir(to, { mode: 0o700 });
        folders.push(to);
        await copy(from, to, level + 1);
        // Docker must be able to traverse and list each staged directory.
        await chmod(to, 0o755);
      } else if (stat.isFile()) {
        if (
          ++fileCount > MAX_FILES ||
          stat.size > MAX_FILE_BYTES ||
          (byteCount += stat.size) > MAX_BYTES
        ) {
          throw new Error('Patch snapshot exceeds its source size limit');
        }
        const sourceHandle = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let bytes: Buffer;
        try {
          const before = await sourceHandle.stat();
          if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) {
            throw new Error('Source file changed while snapshotting');
          }
          bytes = await sourceHandle.readFile();
          const after = await sourceHandle.stat();
          if (
            bytes.length !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          ) {
            throw new Error('Source bytes changed during snapshot');
          }
        } finally {
          await sourceHandle.close();
        }
        const targetHandle = await open(
          to,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        files.push(to);
        try {
          await targetHandle.writeFile(bytes);
          await targetHandle.sync();
          await targetHandle.chmod(0o644);
        } finally {
          await targetHandle.close();
        }
      } else {
        throw new Error('Unsupported file type in patch snapshot');
      }
    }
  }

  let result: T | undefined;
  let actionFailed = false;
  let actionError: unknown;
  try {
    await copy(root, stageRoot, 0);
    if (fileCount === 0) throw new Error('Empty patch check source snapshot');
    // Keep the source stage private until every regular file has been copied.
    await chmod(stageRoot, 0o755);
    result = await action(stageRoot);
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }

  // Remove only files and directories created by this invocation.
  // Never recursively delete a caller-supplied directory or the worktree.
  let cleanupFailed = false;
  for (const file of files.reverse()) {
    try {
      await unlink(file);
    } catch {
      cleanupFailed = true;
    }
  }
  for (const folder of folders.reverse()) {
    try {
      await rmdir(folder);
    } catch {
      cleanupFailed = true;
    }
  }
  try {
    await rmdir(stageRoot);
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error('Patch source snapshot cleanup could not be verified');
  if (actionFailed) throw actionError;
  return result as T;
}
