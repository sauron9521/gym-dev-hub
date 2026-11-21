/**
 * Opt-in, fail-closed primary checkout fast-forward with a VERIFIED prior
 * source backup. The real operator checkout is never changed by default.
 * Never stops/restarts an API/Web process or touches private/ignored state.
 */
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSource, parseStatus } from './launch-source-reconcile.mjs';
import { inspectOperatorProcesses } from './launch-operator-process-provenance.mjs';

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const FILES = Object.freeze(['apps/web/next-env.d.ts', 'turbo.json']);
const BACKUP = Object.freeze({
  'apps/web/next-env.d.ts': 'next-env.d.ts',
  'turbo.json': 'turbo.json',
});
const MAX_FILE = 1024 * 1024;
const BAD_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function canonicalAbsolute(path) {
  return (
    typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\r\n\0]/.test(path)
  );
}
export function parseOwnerFastForwardArgs(argv) {
  if (
    argv.length !== 4 ||
    !['--check-only', '--confirm-owner-fast-forward'].includes(argv[0]) ||
    !argv[1].startsWith('--expected-main=') ||
    !argv[2].startsWith('--operator-checkout=') ||
    !argv[3].startsWith('--verified-backup=')
  ) {
    throw new Error('Expected exact mode, externally pinned main, checkout and prior owner backup');
  }
  const expectedMain = argv[1].slice('--expected-main='.length);
  const checkout = argv[2].slice('--operator-checkout='.length);
  const backup = argv[3].slice('--verified-backup='.length);
  if (
    !SHA.test(expectedMain) ||
    !canonicalAbsolute(checkout) ||
    !canonicalAbsolute(backup) ||
    checkout === backup
  ) {
    throw new Error('Invalid pinned SHA or canonical paths');
  }
  return { mode: argv[0], expectedMain, checkout, backup };
}

function git(root, args, { write = false, allowFailure = false } = {}) {
  const p = spawnSync(
    'git',
    [
      ...(write ? [] : ['--no-optional-locks']),
      '-C',
      root,
      ...(write ? ['-c', 'core.hooksPath=/dev/null', '-c', 'merge.autoStash=false'] : []),
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: write ? 45_000 : 12_000,
      maxBuffer: 128 * 1024,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: write ? '1' : '0',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
  if (p.error || (p.status !== 0 && !allowFailure))
    throw new Error('Git metadata or fast-forward command failed (redacted)');
  return p;
}
function eligible(report) {
  if (
    report.status !== 'preflight-passed' ||
    !report.safeToConsiderOwnerControlledFastForward ||
    report.reasons.length ||
    report.overlappingPaths.length ||
    report.trackedChanges !== FILES.length ||
    !Array.isArray(report.trackedPaths) ||
    report.trackedPaths.slice().sort().join('\0') !== FILES.join('\0')
  )
    throw new Error('Checkout changed or violates strict two-file owner reconciliation policy');
}

async function safePrivateDir(path, parent) {
  if (!canonicalAbsolute(path) || (await realpath(path)) !== path)
    throw new Error('Noncanonical backup path');
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid() ||
    (s.mode & 0o077) !== 0
  )
    throw new Error('Untrusted private backup directory');
  if (parent) {
    const relation = relative(parent, path);
    if (!relation || (relation !== '..' && !relation.startsWith('..' + sep)))
      throw new Error('Backup must be strictly outside the primary source checkout');
  }
}

async function stablePrivateFile(file, { privateOwner = false, max = MAX_FILE } = {}) {
  const before = await lstat(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > max ||
    (privateOwner && (before.uid !== process.getuid() || (before.mode & 0o077) !== 0))
  )
    throw new Error('Source or backup file metadata unsafe');
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const first = await fd.stat();
    if (
      first.dev !== before.dev ||
      first.ino !== before.ino ||
      first.size !== before.size ||
      first.mtimeMs !== before.mtimeMs ||
      first.ctimeMs !== before.ctimeMs
    )
      throw new Error('Source/backup changed before read');
    const bytes = await fd.readFile();
    const after = await fd.stat();
    if (
      bytes.length !== before.size ||
      after.dev !== first.dev ||
      after.ino !== first.ino ||
      after.size !== first.size ||
      after.mtimeMs !== first.mtimeMs ||
      after.ctimeMs !== first.ctimeMs
    )
      throw new Error('Source/backup changed during read');
    return bytes;
  } finally {
    await fd.close();
  }
}

async function verifiedSnapshot(checkout, backup, report, expectedMain) {
  await safePrivateDir(dirname(backup), checkout);
  await safePrivateDir(backup, checkout);
  const manifest = JSON.parse(
    await stablePrivateFile(join(backup, 'manifest.json'), { privateOwner: true, max: 16 * 1024 }),
  );
  if (
    manifest.protocol !== 1 ||
    manifest.mode !== 'BACKUP_ONLY_NO_GIT_WRITES' ||
    manifest.repository !== 'sauron9521/gym-dev-hub' ||
    manifest.sourceHeadSha !== report.localSha ||
    !SHA.test(manifest.externallyPinnedMainSha ?? '') ||
    manifest.approvedFastForward !== false ||
    manifest.gitRefsMutated !== false ||
    manifest.checkoutMutated !== false ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== FILES.length ||
    git(checkout, ['merge-base', '--is-ancestor', manifest.externallyPinnedMainSha, expectedMain], {
      allowFailure: true,
    }).status !== 0
  )
    throw new Error('Verified backup manifest does not belong to the pinned source lineage');

  const result = new Map();
  for (const path of FILES) {
    const item = manifest.files.find((entry) => entry.path === path);
    if (
      !item ||
      item.backupFile !== BACKUP[path] ||
      !HASH.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      item.bytes > MAX_FILE
    )
      throw new Error('Missing or unexpected backup source mapping');
    const copy = await stablePrivateFile(join(backup, item.backupFile), { privateOwner: true });
    const original = await stablePrivateFile(join(checkout, path));
    if (copy.length !== item.bytes || hash(copy) !== item.sha256 || !copy.equals(original))
      throw new Error('Private backup no longer matches the unchanged original');
    result.set(path, item.sha256);
  }
  return result;
}

async function portsAvailable(ports) {
  for (const port of [...new Set(ports)]) {
    const free = await new Promise((resolveResult) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolveResult(ok);
      };
      socket.setTimeout(1500, () => done(false));
      socket.once('connect', () => done(false));
      socket.once('error', (err) => done(err.code === 'ECONNREFUSED'));
    });
    if (!free) return false;
  }
  return true;
}
export { portsAvailable };

function operatorPorts(env) {
  const numbers = [3100, 3101];
  for (const variable of ['DEV_HUB_OPERATOR_API_PORT', 'DEV_HUB_OPERATOR_WEB_PORT']) {
    if (env[variable] === undefined || env[variable] === '') continue;
    const value = Number(env[variable]);
    if (!Number.isSafeInteger(value) || value < 1024 || value > 65535)
      throw new Error('Operator port override invalid; no fast-forward authorized');
    numbers.push(value);
  }
  return numbers;
}
function statusUntracked(checkout) {
  const raw = git(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).stdout;
  const parsed = parseStatus(raw);
  if (
    parsed.untracked.some((item) => item !== '.worktrees/') ||
    parsed.unsafeRenames ||
    parsed.unsafeIndex ||
    parsed.tracked.slice().sort().join('\0') !== FILES.join('\0')
  )
    throw new Error('Unexpected untracked or staged checkout state');
}

export async function runOwnerFastForward({
  mode,
  expectedMain,
  checkout,
  backup,
  ports = operatorPorts(process.env),
  processInspector = inspectOperatorProcesses,
}) {
  if (process.platform !== 'linux' || process.getuid?.() === 0)
    throw new Error('Nonroot Linux owner required');
  if (BAD_GIT_ENV.some((key) => process.env[key]))
    throw new Error('Git worktree/index environment overrides not allowed');
  if (!canonicalAbsolute(checkout) || !canonicalAbsolute(backup) || !SHA.test(expectedMain))
    throw new Error('Invalid source/backup path or externally pinned SHA');
  if ((await realpath(checkout)) !== checkout) throw new Error('Noncanonical primary checkout');
  const gitDir = await lstat(join(checkout, '.git'));
  if (!gitDir.isDirectory() || gitDir.isSymbolicLink())
    throw new Error('Linked worktree or symlinked Git administrative path refused');
  const preflight = inspectSource(checkout, expectedMain);
  eligible(preflight);
  statusUntracked(checkout);
  const bytes = await verifiedSnapshot(checkout, backup, preflight, expectedMain);
  const before = inspectSource(checkout, expectedMain);
  eligible(before);
  statusUntracked(checkout);
  if (before.localSha !== preflight.localSha)
    throw new Error('Checkout HEAD changed before authorization');
  if (!(await portsAvailable(ports)))
    return {
      status: 'blocked-operator-ports-active',
      mayFastForward: false,
      backupVerified: true,
      sourceHeadSha: before.localSha,
      targetMainSha: expectedMain,
      gitWritesPerformed: false,
      runtimeRestarted: false,
    };
  const runtime = await processInspector(checkout);
  if (
    !runtime ||
    !Number.isSafeInteger(runtime.totalBlocking) ||
    runtime.totalBlocking < 0 ||
    runtime.status !==
      (runtime.totalBlocking === 0
        ? 'no-known-operator-processes-at-scan-time'
        : 'operator-processes-not-confirmed-stopped')
  )
    throw new Error('Untrusted operator process inspection result');
  if (runtime.totalBlocking)
    return {
      status: 'blocked-operator-processes-active',
      mayFastForward: false,
      backupVerified: true,
      sourceHeadSha: before.localSha,
      targetMainSha: expectedMain,
      gitWritesPerformed: false,
      runtimeRestarted: false,
      detectedOperatorProcesses: runtime.totalBlocking,
    };
  if (mode === '--check-only')
    return {
      status: 'owner-cutover-preflight-passed',
      mayFastForward: false,
      backupVerified: true,
      sourceHeadSha: before.localSha,
      targetMainSha: expectedMain,
      gitWritesPerformed: false,
      runtimeRestarted: false,
    };
  if (mode !== '--confirm-owner-fast-forward')
    throw new Error('Owner did not confirm one bounded fast-forward');
  // Recheck HEAD/index and source bytes immediately before the sole Git write.
  eligible(inspectSource(checkout, expectedMain));
  statusUntracked(checkout);
  const latestRuntime = await processInspector(checkout);
  if (
    !latestRuntime ||
    latestRuntime.status !== 'no-known-operator-processes-at-scan-time' ||
    latestRuntime.totalBlocking !== 0 ||
    !(await portsAvailable(ports))
  )
    throw new Error('Operator process or port became active before source update');
  for (const path of FILES)
    if (hash(await stablePrivateFile(join(checkout, path))) !== bytes.get(path))
      throw new Error('Local source changed since verified backup');

  git(checkout, ['merge', '--ff-only', '--no-stat', expectedMain], { write: true });
  // Never retry or rollback ambiguous Git failure automatically.
  const after = inspectSource(checkout, expectedMain);
  if (
    !after.upToDate ||
    after.localSha !== expectedMain ||
    after.trackedPaths.slice().sort().join('\0') !== FILES.join('\0') ||
    after.unsafeIndex ||
    after.unsafeRenames
  ) {
    throw new Error('Fast-forward postconditions uncertain; owner must inspect source');
  }
  statusUntracked(checkout);
  for (const path of FILES)
    if (hash(await stablePrivateFile(join(checkout, path))) !== bytes.get(path))
      throw new Error('Tracked local edit changed after Git fast-forward');
  return {
    status: 'owner-fast-forward-verified',
    mayFastForward: false,
    backupVerified: true,
    sourceHeadSha: before.localSha,
    targetMainSha: expectedMain,
    gitWritesPerformed: true,
    preservedTrackedEdits: 2,
    ignoredPrivateFilesRead: false,
    privateStateMutated: false,
    runtimeRestarted: false,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseOwnerFastForwardArgs(argv);
  const report = await runOwnerFastForward(args);
  process.stdout.write(JSON.stringify(report) + '\n');
  if (
    report.status === 'blocked-operator-ports-active' ||
    report.status === 'blocked-operator-processes-active'
  )
    process.exitCode = 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(
      'OWNER_FAST_FORWARD_REJECTED; investigate preflight, backup and runtime; no secret or source data logged\n',
    );
    process.exitCode = 2;
  });
}
