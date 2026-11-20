/**
 * CI-only full tracked-source snapshot auditor.
 * Never executes target code, launches pnpm or exposes a user command.
 * Manifest digest is independently pinned in this reviewed runner image.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE = '/source';
const MANIFEST = '/manifest';
const MANIFEST_NAME = 'tracked-files.bin';
const SOURCE_COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const SOURCE_TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const EXPECTED_MANIFEST_SHA256 = 'REPLACE_AFTER_VERIFIED_CI_MANIFEST_GENERATION';
const EXPECTED_FILES = 1258;
const EXPECTED_BYTES = 6241392;
const EXPECTED_EXECUTABLES = 1;
const MAX_FILE_BYTES = 1_000_000;
const MAX_MANIFEST_BYTES = 350_000;

function hashBlob(bytes) {
  return createHash('sha1')
    .update(Buffer.from('blob ' + bytes.length + '\0'))
    .update(bytes)
    .digest('hex');
}

async function checkedDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Expected a real source/manifest directory');
  }
}

function readManifestEntries(bytes) {
  if (
    bytes.length === 0 ||
    bytes.length > MAX_MANIFEST_BYTES ||
    bytes[bytes.length - 1] !== 0
  ) {
    throw new Error('Manifest is missing, oversized or not NUL-delimited');
  }

  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== EXPECTED_MANIFEST_SHA256) {
    throw new Error('Manifest differs from independently reviewed Git tree pin');
  }

  const parts = bytes.toString('utf8').split('\0');
  if (parts.pop() !== '') throw new Error('Malformed Git tree manifest');

  const records = new Map();
  let total = 0;
  let executable = 0;
  for (const line of parts) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/.exec(line);
    if (!match) throw new Error('Unrecognized Git tree entry');
    const [, mode, sha, sizeText, name] = match;
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.includes('\0') ||
      /[\r\n\t]/.test(name) ||
      name.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment === '.git') ||
      records.has(name)
    ) {
      throw new Error('Unsafe or duplicate Git source path');
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      throw new Error('Unbounded source file');
    }
    total += size;
    if (mode === '100755') executable++;
    records.set(name, { mode, sha, size });
  }

  if (
    records.size !== EXPECTED_FILES ||
    total !== EXPECTED_BYTES ||
    executable !== EXPECTED_EXECUTABLES
  ) {
    throw new Error('Source tree count, size or mode drift');
  }
  return { records, digest, total, executable };
}

async function verifySnapshot(root, expected) {
  const pending = [{ path: root, relative: '', depth: 0 }];
  const observed = new Set();
  let observedBytes = 0;
  let executable = 0;
  while (pending.length) {
    const dir = pending.pop();
    if (dir.depth > 14) throw new Error('Excessive source directory depth');
    await checkedDirectory(dir.path);
    for (const name of await readdir(dir.path)) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        throw new Error('Unsafe source directory entry');
      }
      const relative = dir.relative ? dir.relative + '/' + name : name;
      if (relative === '.git' || name === '.git') throw new Error('Git metadata exposed in source');
      const path = join(dir.path, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Source symlink rejected');
      if (info.isDirectory()) {
        pending.push({ path, relative, depth: dir.depth + 1 });
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error('Unexpected special or hardlinked source file');
      }
      const item = expected.get(relative);
      if (!item || observed.has(relative)) throw new Error('Extra or duplicate file in snapshot');
      if (info.size !== item.size || info.size > MAX_FILE_BYTES) {
        throw new Error('Source file size differs from Git tree');
      }
      const actualExecutable = (info.mode & 0o111) !== 0;
      if (actualExecutable !== (item.mode === '100755')) {
        throw new Error('Source file executable mode mismatch');
      }
      const bytes = await readFile(path);
      if (bytes.length !== info.size || hashBlob(bytes) !== item.sha) {
        throw new Error('Source file differs from pinned Git blob');
      }
      observed.add(relative);
      observedBytes += bytes.length;
      if (actualExecutable) executable++;
    }
  }
  if (observed.size !== expected.size || observedBytes !== EXPECTED_BYTES) {
    throw new Error('Missing source files or unexpected total size');
  }
  return { count: observed.size, bytes: observedBytes, executable };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No arguments or user commands accepted');
  await checkedDirectory(SOURCE);
  await checkedDirectory(MANIFEST);
  const names = await readdir(MANIFEST);
  if (names.length !== 1 || names[0] !== MANIFEST_NAME) {
    throw new Error('Unapproved manifest input');
  }
  const manifestPath = join(MANIFEST, MANIFEST_NAME);
  const stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error('Unsafe manifest file');
  }
  const { records, digest, total, executable } = readManifestEntries(
    await readFile(manifestPath),
  );
  const observed = await verifySnapshot(SOURCE, records);
  if (observed.executable !== executable || observed.bytes !== total) {
    throw new Error('Observed Git file mode or size changed');
  }
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'immutable-full-source-snapshot-verified',
      repository: 'sauron9521/gym-platform',
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
      manifestSha256: digest,
      trackedFiles: observed.count,
      sourceBytes: observed.bytes,
      executableFileModes: observed.executable,
      exactTrackedTree: true,
      untrackedOrGitMetadataMounted: false,
      sourceMountedReadOnly: true,
      sourceCodeExecuted: false,
      dependenciesInstalled: false,
      projectScriptsExecuted: false,
      arbitraryExecutionEnabled: false,
      operatorGrantIssued: false,
    }) + '\n',
  );
}

main().catch((error) => {
  const description = error instanceof Error ? error.message.slice(0, 350) : 'unknown';
  process.stderr.write('Full pinned source snapshot rejected: ' + description + '\n');
  process.exitCode = 1;
});
