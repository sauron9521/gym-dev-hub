/**
 * Linux-only, deliberately bounded mirror of a verified PUBLIC pnpm store.
 * Docker runs as UID 65534 while original provisioned store remains 0700/0600.
 * Only a fresh /tmp stage is made readable, never the operator's original.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { validatePinnedStoreManifest } from './worktree-patch-checks-docker.js';

const MAX_FILES = 80_000;
const MAX_BYTES = 1_600 * 1024 * 1024;
const MAX_LOCK_BYTES = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4096;
const STAGE_PREFIX = '/tmp/gym-dev-hub-patch-store-';

async function canonicalPrivateStore(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || /[\r\n\0,]/.test(path)) {
    throw new Error('Unsafe pinned store path');
  }
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error('Redirected pinned store path');
  let current = path;
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Pinned store parent is not a real directory');
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return canonical;
}

async function smallFile(path: string, maxBytes: number, privateFile = false): Promise<Buffer> {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maxBytes ||
    (privateFile && process.platform !== 'win32' && (before.mode & 0o077) !== 0)
  ) {
    throw new Error('Unsafe pinned store manifest or source lock');
  }
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await fd.stat();
    if (actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) {
      throw new Error('Pinned store metadata changed before read');
    }
    const bytes = await fd.readFile();
    const after = await fd.stat();
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error('Pinned store metadata changed during read');
    }
    return bytes;
  } finally {
    await fd.close();
  }
}

export interface PinnedStoreMirrorEvidence {
  files: number;
  bytes: number;
  digest: string;
}

/**
 * Copy all and only the provisioner's bounded content graph, with the same
 * deterministic sorted-path SHA-256 digest as inspectStore(). Reject corrupt,
 * stale, linked, or changed sources BEFORE publishing the stage to Docker.
 */
export async function withPatchCheckStoreStage<T>(
  privateStore: string,
  lockFile: string,
  signal: AbortSignal,
  action: (publicStore: string, evidence: PinnedStoreMirrorEvidence) => Promise<T>,
): Promise<T> {
  if (process.platform !== 'linux' || process.getuid?.() === 0) {
    throw new Error('Non-root Linux is required for Docker store staging');
  }
  if (!privateStore || signal.aborted) throw new Error('Store staging canceled or unconfigured');

  const store = await canonicalPrivateStore(privateStore);
  const key = basename(store);
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Unexpected pinned store key');
  const lock = await smallFile(lockFile, MAX_LOCK_BYTES);
  const rawManifest = await smallFile(store + '.json', MAX_MANIFEST_BYTES, true);
  validatePinnedStoreManifest(rawManifest.toString('utf8'), lock, key);
  const manifest = JSON.parse(rawManifest.toString('utf8')) as {
    storeDigest: string;
    files: number;
    bytes: number;
  };

  // The /tmp sticky directory must be real. Never accept a redirected TMPDIR.
  const tmpStat = await lstat('/tmp');
  if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink() || (tmpStat.mode & 0o1000) === 0) {
    throw new Error('Unsafe public store staging parent');
  }
  const root = await mkdtemp(STAGE_PREFIX);
  const mirror = join(root, key);
  let files = 0;
  let bytes = 0;
  const digest = createHash('sha256');

  async function copyFolder(source: string, target: string, relative: string): Promise<void> {
    if (signal.aborted) throw new Error('Docker store staging canceled');
    await mkdir(target, { mode: 0o700 });
    for (const name of (await readdir(source)).sort()) {
      const path = relative ? relative + '/' + name : name;
      if (path === 'v11/projects') continue; // untrusted host project bookkeeping
      const from = join(source, name);
      const to = join(target, name);
      const before = await lstat(from);
      if (before.isSymbolicLink()) throw new Error('Symlink in pinned store');
      if (before.isDirectory()) {
        await copyFolder(from, to, path);
        continue;
      }
      if (!before.isFile()) throw new Error('Unsupported pinned store entry');
      files += 1;
      bytes += before.size;
      if (files > MAX_FILES || bytes > MAX_BYTES || signal.aborted) {
        throw new Error('Pinned store exceeds staging bounds or canceled');
      }
      digest.update(path + '\0' + before.size + '\0');
      const sourceFile = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = await sourceFile.stat();
        if (
          !actual.isFile() ||
          actual.dev !== before.dev ||
          actual.ino !== before.ino ||
          actual.size !== before.size
        )
          throw new Error('Pinned store file changed');
        const dest = await open(
          to,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        let copied = 0;
        try {
          for await (const chunk of sourceFile.createReadStream({ autoClose: false })) {
            if (signal.aborted) throw new Error('Docker store staging canceled');
            await dest.writeFile(chunk);
            digest.update(chunk);
            copied += chunk.length;
          }
          const after = await sourceFile.stat();
          if (
            copied !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          ) {
            throw new Error('Pinned store content changed during copy');
          }
          await dest.chmod(0o644);
        } finally {
          await dest.close();
        }
        digest.update('\0');
      } finally {
        await sourceFile.close();
      }
    }
    // All children must be verified before the container UID can traverse.
    await chmod(target, 0o755);
  }

  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    await copyFolder(store, mirror, '');
    const observed: PinnedStoreMirrorEvidence = {
      files,
      bytes,
      digest: digest.digest('hex'),
    };
    if (
      files !== manifest.files ||
      bytes !== manifest.bytes ||
      observed.digest !== manifest.storeDigest ||
      signal.aborted
    ) {
      throw new Error('Pinned store digest changed; Docker stage denied');
    }
    const manifestCopy = join(root, key + '.json');
    const output = await open(
      manifestCopy,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await output.writeFile(rawManifest);
    } finally {
      await output.close();
    }
    // Only verified, public package bytes become readable for UID 65534.
    await chmod(root, 0o755);
    result = await action(mirror, observed);
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }

  // Fail closed on cleanup errors: never return a successful Docker receipt
  // if the temporary public dependency stage could not be removed.
  let cleanupError: unknown;
  try {
    if (!root.startsWith(STAGE_PREFIX)) throw new Error('Unexpected stage ownership');
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Stage cleanup safety could not be established');
    }
    await rm(root, { recursive: true, force: false });
    await lstat(root).then(
      () => {
        throw new Error('Stage cleanup did not remove snapshot');
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError)
    throw new Error('Docker store stage cleanup could not be verified', {
      cause: cleanupError,
    });
  if (operationFailed) throw operationError;
  return result as T;
}
