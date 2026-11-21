/**
 * Owner-confirmed COPY-ONLY backup before source reconciliation (#107).
 * No Git write/fetch/merge/reset, no .env or .local content, no service restarts.
 * Only the two current known tracked source edits are backed up.
 */
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSource } from './launch-source-reconcile.mjs';

const SHA = /^[a-f0-9]{40}$/;
const FILES = Object.freeze(['apps/web/next-env.d.ts', 'turbo.json']);
const MAX_SIZE = 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function absoluteCanonical(value) {
  return isAbsolute(value) && resolve(value) === value && !/[\r\n\0]/.test(value);
}
export function parseBackupArgs(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== '--confirm-copy-only' ||
    !argv[1].startsWith('--expected-main=') ||
    !argv[2].startsWith('--operator-checkout=') ||
    !argv[3].startsWith('--backup-parent=')
  ) {
    throw new Error(
      'Expected exact opt-in, pinned main SHA, operator checkout and private backup parent',
    );
  }
  const expectedMain = argv[1].slice('--expected-main='.length);
  const checkout = argv[2].slice('--operator-checkout='.length);
  const parent = argv[3].slice('--backup-parent='.length);
  if (
    !SHA.test(expectedMain) ||
    !absoluteCanonical(checkout) ||
    !absoluteCanonical(parent) ||
    checkout === parent
  )
    throw new Error('Invalid pinned SHA or canonical source/backup paths');
  return { expectedMain, checkout, parent };
}

export function validateBackupEligibility(report) {
  if (
    report.status !== 'preflight-passed' ||
    !report.safeToConsiderOwnerControlledFastForward ||
    report.upToDate ||
    report.localSha === report.targetSha ||
    report.reasons.length ||
    report.overlappingPaths.length ||
    report.trackedChanges !== FILES.length ||
    !Array.isArray(report.trackedPaths) ||
    report.trackedPaths.slice().sort().join('\0') !== FILES.join('\0')
  ) {
    throw new Error('Current checkout is not eligible for the fixed two-file backup');
  }
  return FILES.slice();
}

async function checkPrivateBackupParent(parent, root) {
  const real = await realpath(parent);
  const metadata = await lstat(parent);
  const nested = relative(root, parent);
  if (
    real !== parent ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o077) !== 0 ||
    nested === '' ||
    (nested !== '..' && !nested.startsWith('..' + sep))
  ) {
    throw new Error('Backup directory is not a private, separate existing owner directory');
  }
}

async function readStableFile(fullPath) {
  const before = await lstat(fullPath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > MAX_SIZE
  )
    throw new Error('Unexpected source file metadata; no backup authorized');
  const fd = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const start = await fd.stat();
    if (
      !start.isFile() ||
      start.ino !== before.ino ||
      start.dev !== before.dev ||
      start.size !== before.size ||
      start.mtimeMs !== before.mtimeMs ||
      start.ctimeMs !== before.ctimeMs
    )
      throw new Error('Source file changed during snapshot inspection');
    const bytes = await fd.readFile();
    const after = await fd.stat();
    if (
      bytes.length !== before.size ||
      after.ino !== start.ino ||
      after.dev !== start.dev ||
      after.size !== start.size ||
      after.mtimeMs !== start.mtimeMs ||
      after.ctimeMs !== start.ctimeMs
    )
      throw new Error('Source file changed while snapshotting');
    return bytes;
  } finally {
    await fd.close();
  }
}

async function writeDurablePrivateFile(dir, name, bytes) {
  // Files are flat, new, and exclusively created inside a fresh 0700 dir.
  if (!/^[a-z0-9][a-z0-9.-]{0,80}$/.test(name)) throw new Error('Unexpected backup filename');
  const fd = await open(
    join(dir, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
}

async function fsyncDirectory(dir) {
  const fd = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}

export async function createOwnerBackup({ expectedMain, checkout, parent }) {
  if (process.platform !== 'linux' || process.getuid?.() === 0)
    throw new Error('Owner-only non-root Linux backup');
  const checkoutActual = await realpath(checkout);
  if (checkoutActual !== checkout) throw new Error('Symlinked checkout refused');
  await checkPrivateBackupParent(parent, checkoutActual);
  const before = inspectSource(checkout, expectedMain);
  const tracked = validateBackupEligibility(before);
  const data = [];
  for (const path of tracked) {
    const bytes = await readStableFile(join(checkout, path));
    data.push({ path, bytes, sha256: sha256(bytes) });
  }
  // Repeat the no-Git-write provenance preflight after reading dirty bytes.
  const during = inspectSource(checkout, expectedMain);
  validateBackupEligibility(during);
  if (
    during.localSha !== before.localSha ||
    during.targetSha !== before.targetSha ||
    during.trackedPaths.join('\0') !== before.trackedPaths.join('\0')
  )
    throw new Error('Checkout changed while backing up');

  // Fresh 0700 snapshot in the owner-supplied, already existing private
  // directory. Never replace an existing backup or modify the checkout.
  const snapshot = await mkdtemp(join(parent, 'source-owner-backup-'));
  const files = [];
  for (const item of data) {
    const name = item.path === 'turbo.json' ? 'turbo.json' : 'next-env.d.ts';
    await writeDurablePrivateFile(snapshot, name, item.bytes);
    const copied = await readStableFile(join(snapshot, name));
    if (sha256(copied) !== item.sha256)
      throw new Error('Backup verification failed: preserve snapshot for owner review');
    files.push({
      path: item.path,
      backupFile: name,
      bytes: item.bytes.length,
      sha256: item.sha256,
    });
  }
  const manifest = {
    protocol: 1,
    mode: 'BACKUP_ONLY_NO_GIT_WRITES',
    repository: 'sauron9521/gym-dev-hub',
    sourceHeadSha: before.localSha,
    externallyPinnedMainSha: expectedMain,
    files,
    untrackedWorktreesPreserved: true,
    checkoutMutated: false,
    gitRefsMutated: false,
    productionAuditMutated: false,
    serverRestarted: false,
    approvedFastForward: false,
  };
  await writeDurablePrivateFile(
    snapshot,
    'manifest.json',
    Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
  );
  await fsyncDirectory(snapshot);
  await fsyncDirectory(parent);
  const after = inspectSource(checkout, expectedMain);
  validateBackupEligibility(after);
  for (const item of data) {
    if (sha256(await readStableFile(join(checkout, item.path))) !== item.sha256)
      throw new Error('Checkout content changed after snapshot; owner must recheck');
  }
  if (after.localSha !== before.localSha || after.targetSha !== before.targetSha)
    throw new Error('Git refs changed during backup');
  return {
    status: 'verified-private-source-backup-only',
    backupDirectory: snapshot,
    trackedFilesPreserved: files.length,
    sourceHeadSha: before.localSha,
    targetMainSha: expectedMain,
    primaryCheckoutMutated: false,
    privateStateBackedUp: false,
    privateStateTouched: false,
    gitRefsMutated: false,
    runtimeRestarted: false,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseBackupArgs(argv);
  const result = await createOwnerBackup(options);
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Path, secret and file content never appear in error output.
    process.stderr.write(
      'SOURCE_OWNER_BACKUP_REJECTED; review owner preflight and private snapshot\n',
    );
    process.exitCode = 2;
  });
}
