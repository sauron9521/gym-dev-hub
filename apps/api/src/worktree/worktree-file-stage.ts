import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { WorktreePlan } from '@gym-dev-hub/contracts';
import { validateScopedCodePath } from './worktree-mount-probe.js';

const MAX_BYTES = 8_192;
const GIT_SHA = /^[0-9a-f]{40,64}$/;

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
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
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

/** Reads a pinned Git blob, never the mutable hydrated file, via fixed no-shell Git arguments. */
function readPinnedBlob(plan: WorktreePlan, filePath: string): Promise<Buffer> {
  if (!plan.baseHeadSha || !GIT_SHA.test(plan.baseHeadSha)) {
    return Promise.reject(new Error('Missing immutable Git commit'));
  }
  return new Promise((accept, reject) => {
    execFile(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=.devhub-disabled-hooks',
        '-C',
        plan.sourcePath,
        'cat-file',
        'blob',
        plan.baseHeadSha + ':' + filePath,
      ],
      {
        shell: false,
        windowsHide: true,
        encoding: 'buffer',
        timeout: 12_000,
        maxBuffer: MAX_BYTES + 1,
        env: isolatedGitEnvironment(),
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Approved Git blob unavailable or too large'));
          return;
        }
        const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        if (bytes.length > MAX_BYTES) {
          reject(new Error('Approved Git blob exceeds limit'));
          return;
        }
        accept(bytes);
      },
    );
  });
}

export type PinnedStage = {
  sourcePath: string;
  fileName: string;
  sha256: string;
  bytes: Buffer;
};

/**
 * Mount a private, random, ONE-FILE snapshot of the approved pinned Git blob.
 * The worktree is never chmod'd or mounted here. Stage directory mode 0711
 * permits traversal by the unprivileged Docker UID but not directory listing;
 * only the single staged file is mode 0644 while this callback is running.
 *
 * Cleanup is NON-recursive: only our exclusive file and empty stage folder
 * may be removed. Any cleanup uncertainty rejects the operation.
 */
export async function withPinnedFileStage<T>(
  plan: WorktreePlan,
  filePath: string,
  action: (stage: PinnedStage) => Promise<T>,
): Promise<T> {
  if (process.env.DEV_HUB_ENABLE_PINNED_FILE_STAGE !== 'true') {
    throw new Error('Ephemeral pinned file staging is not enabled');
  }
  validateScopedCodePath(filePath);
  const root = await realpath(plan.targetPath);
  if (root !== resolve(plan.targetPath) || !(await lstat(root)).isDirectory()) {
    throw new Error('Worktree source must be a canonical ordinary directory');
  }
  const original = await lstat(join(root, ...filePath.split('/')));
  if (!original.isFile() || original.isSymbolicLink() || original.size > MAX_BYTES) {
    throw new Error('Only an approved small regular file may be staged');
  }
  const bytes = await readPinnedBlob(plan, filePath);
  if (bytes.length !== original.size) {
    throw new Error('Hydrated source no longer matches the pinned Git blob');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const stageFolder = await mkdtemp(join(dirname(root), '.gym-dev-hub-stage-'));
  // The staging path is new and unguessable, never derived from user input.
  const fileName = basename(filePath);
  const stageFile = join(stageFolder, fileName);
  let created = false;
  try {
    // The folder is not listable to other local users but Docker UID may traverse it.
    await chmod(stageFolder, 0o711);
    const handle = await open(
      stageFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o644);
    } finally {
      await handle.close();
    }
    const staged = await lstat(stageFile);
    if (!staged.isFile() || staged.isSymbolicLink() || staged.size !== bytes.length) {
      throw new Error('Unexpected staged file type or size');
    }
    return await action({ sourcePath: stageFolder, fileName, bytes, sha256 });
  } finally {
    // No rm -rf, and never delete anything outside the random directory.
    try {
      if (created) await unlink(stageFile);
    } finally {
      await rmdir(stageFolder);
    }
  }
}
