/**
 * CI-only, single real npm artifact digest probe. Not accessible from the
 * runner.mjs protocol or NestJS API. No archive extraction or package scripts.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const INPUT = '/input';
const CACHE = '/cache';
const FILENAME = 'is-number-7.0.0.tgz';
const IDENTITY = 'is-number@7.0.0';
const LOCK_COMMIT = '73b636f5d064c7f24b43607e0c8411e9161f8986';
const PINNED_SRI =
  'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==';
const MAX_BYTES = 131_072;

function assertSafeBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAX_BYTES) {
    throw new Error('Unsafe artifact size');
  }
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) {
    throw new Error('Artifact is not a gzip file');
  }
  const received = createHash('sha512').update(bytes).digest();
  const expected = Buffer.from(PINNED_SRI.slice('sha512-'.length), 'base64');
  if (received.length !== 64 || expected.length !== 64 || !timingSafeEqual(received, expected)) {
    throw new Error('Artifact does not match independently reviewed lockfile SRI');
  }
  return received;
}

async function verifyDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Unsafe artifact or cache directory');
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No runtime arguments are allowed');
  await verifyDirectory(INPUT);
  await verifyDirectory(CACHE);

  const sourcePath = join(INPUT, FILENAME);
  const sourceStat = await lstat(sourcePath);
  if (
    !sourceStat.isFile() ||
    sourceStat.isSymbolicLink() ||
    sourceStat.size < 32 ||
    sourceStat.size > MAX_BYTES
  ) {
    throw new Error('Unsafe or missing npm artifact');
  }
  const bytes = await readFile(sourcePath);
  if (bytes.length !== sourceStat.size) throw new Error('Artifact changed during read');
  const digest = assertSafeBytes(bytes);
  const cacheKey = 'sha512-' + digest.toString('hex');
  const dest = join(CACHE, cacheKey + '.tgz');

  // The cache is a fresh, disposable tmpfs; never reuse a shared writable store.
  const handle = await open(dest, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const staged = await readFile(dest);
    if (!staged.equals(bytes)) throw new Error('Cache readback mismatch');
  } catch (error) {
    await unlink(dest).catch(() => undefined);
    throw error;
  }

  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'real-npm-artifact-pinned',
      package: IDENTITY,
      reviewedCommit: LOCK_COMMIT,
      integrity: PINNED_SRI,
      cacheKey,
      artifactBytes: bytes.length,
      scriptsExecuted: false,
      extracted: false,
      dependencyInstallationExecuted: false,
      runtimeNetworkAccess: false,
      executionEnabled: false,
    }) + '\n',
  );
}

main().catch(() => {
  process.stderr.write('Real npm package rejected by pinned artifact policy\n');
  process.exitCode = 1;
});
