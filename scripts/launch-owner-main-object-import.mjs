/**
 * Pin and import only the already advertised GitHub main commit object into
 * the trusted owner primary Git object store. Never changes HEAD, refs, index,
 * worktree, systemd or Docker. Read-only unless explicitly owner-confirmed.
 */
import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSource } from './launch-source-reconcile.mjs';

const SHA = /^[0-9a-f]{40}$/;
const URL = 'https://github.com/sauron9521/gym-dev-hub.git';
const REF = 'refs/heads/main';
const TRACKED = ['apps/web/next-env.d.ts', 'turbo.json'];
const FORBIDDEN = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_GLOBAL',
];
const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
};

function absolute(value) {
  return (
    typeof value === 'string' &&
    value.length > 1 &&
    value.length <= 1024 &&
    isAbsolute(value) &&
    resolve(value) === value &&
    !/[\r\n\0]/.test(value) &&
    !value.includes('//') &&
    !value.includes('/./') &&
    !value.includes('/../')
  );
}

export function parseOwnerMainImportArgs(argv) {
  if (
    argv.length !== 3 ||
    !['--check-only', '--confirm-owner-main-object-import'].includes(argv[0]) ||
    !argv[1].startsWith('--expected-main=') ||
    !argv[2].startsWith('--operator-checkout=')
  )
    throw new Error('Require exact mode, externally pinned main SHA and physical owner primary');
  const expectedMain = argv[1].slice('--expected-main='.length);
  const checkout = argv[2].slice('--operator-checkout='.length);
  if (!SHA.test(expectedMain) || !absolute(checkout))
    throw new Error('Invalid SHA or canonical checkout');
  return { mode: argv[0], expectedMain, checkout };
}

function git(args, { cwd = null, timeout = 10_000 } = {}) {
  const out = spawnSync('git', args, {
    cwd: cwd ?? undefined,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024,
    env: GIT_ENV,
  });
  if (out.error || out.status !== 0)
    throw new Error('Pinned Git operation unavailable or failed; never auto-retry');
  return out.stdout.trim();
}
function currentRemoteMain() {
  const out = git(['-c', 'credential.helper=', 'ls-remote', '--exit-code', URL, REF], {
    timeout: 15_000,
  });
  const columns = out.split(/\s+/);
  if (columns.length !== 2 || !SHA.test(columns[0]) || columns[1] !== REF)
    throw new Error('Untrusted GitHub main advertisement');
  return columns[0];
}
function importPinnedObject(checkout, sha) {
  // Fixed trusted HTTPS URL, detached commit *without* a destination refspec:
  // no refs/remotes update, no FETCH_HEAD write, no branch switch or hooks.
  git(
    [
      '-c',
      'credential.helper=',
      '-C',
      checkout,
      'fetch',
      '--no-write-fetch-head',
      '--no-tags',
      '--no-recurse-submodules',
      '--no-auto-gc',
      '--quiet',
      URL,
      sha,
    ],
    { timeout: 90_000 },
  );
}
function refSnapshot(checkout) {
  return git(['-C', checkout, 'for-each-ref', '--format=%(refname) %(objectname)']);
}

function acceptable(report, expectedMain) {
  if (
    !report ||
    !SHA.test(report.localSha) ||
    report.targetSha !== expectedMain ||
    report.onlyKnownOwnerUntracked !== true ||
    (report.trackedChanges !== 0 &&
      (report.trackedChanges !== TRACKED.length ||
        report.trackedPaths?.slice().sort().join('\0') !== TRACKED.join('\0')))
  )
    throw new Error('Untrusted physical owner source or unexpected local changes');
  if (report.status === 'up-to-date' || report.status === 'preflight-passed') {
    if (report.reasons.length) throw new Error('Available main object is unsafe');
    return true;
  }
  const allowed = ['not-a-fast-forward', 'target-commit-not-present-locally'];
  if (
    report.status !== 'blocked' ||
    report.reasons.length !== allowed.length ||
    report.reasons.some((x) => !allowed.includes(x))
  )
    throw new Error('Owner source blocked for reasons other than missing main object');
  return false;
}

async function trustedPrimary(checkout) {
  const [physical, root, admin] = await Promise.all([
    realpath(checkout),
    lstat(checkout),
    lstat(join(checkout, '.git')),
  ]);
  if (
    physical !== checkout ||
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== process.getuid() ||
    !admin.isDirectory() ||
    admin.isSymbolicLink() ||
    admin.uid !== process.getuid()
  )
    throw new Error('Physical owned primary Git directory required, not linked worktree');
}

/** Dependencies may be overridden only by hermetic tests, never via CLI. */
export async function runOwnerMainObjectImport(
  { mode, expectedMain, checkout },
  {
    remoteMain = currentRemoteMain,
    fetch = importPinnedObject,
    refs = refSnapshot,
    inspect = inspectSource,
  } = {},
) {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() === 0 ||
    !absolute(checkout) ||
    !SHA.test(expectedMain) ||
    !['--check-only', '--confirm-owner-main-object-import'].includes(mode) ||
    FORBIDDEN.some((name) => Object.hasOwn(process.env, name))
  )
    throw new Error('Untrusted owner process, Git environment or CLI arguments');
  await trustedPrimary(checkout);
  const initial = inspect(checkout, expectedMain);
  const present = acceptable(initial, expectedMain);
  if ((await remoteMain()) !== expectedMain)
    throw new Error('Pinned SHA is not the exact live advertised GitHub main');
  const base = {
    targetMainSha: expectedMain,
    originalOwnerHeadSha: initial.localSha,
    targetObjectPresent: present,
    ownerCheckoutChanged: false,
    refsChanged: false,
    serviceStoppedOrRestarted: false,
    dockerExecuted: false,
    endToEndVerified: false,
  };
  if (mode === '--check-only') {
    return {
      status: present
        ? 'pinned-main-object-already-available'
        : 'pinned-main-object-import-preflight',
      ...base,
      gitObjectStoreMutated: false,
      requiresSeparateOwnerApprovalToImport: !present,
    };
  }
  if (present) {
    return {
      status: 'pinned-main-object-already-available',
      ...base,
      gitObjectStoreMutated: false,
    };
  }

  const before = inspect(checkout, expectedMain);
  if (
    acceptable(before, expectedMain) ||
    before.localSha !== initial.localSha ||
    before.trackedPaths?.slice().sort().join('\0') !==
      initial.trackedPaths?.slice().sort().join('\0') ||
    before.untrackedEntries !== initial.untrackedEntries
  )
    throw new Error('Owner checkout changed before confirmed import');
  const oldRefs = await refs(checkout);
  if ((await remoteMain()) !== expectedMain) throw new Error('Upstream main moved before import');
  await fetch(checkout, expectedMain); // ONE bounded object transfer; NEVER retry.
  const after = inspect(checkout, expectedMain);
  if (
    after.status !== 'preflight-passed' ||
    after.localSha !== initial.localSha ||
    after.targetSha !== expectedMain ||
    after.trackedPaths?.slice().sort().join('\0') !==
      initial.trackedPaths?.slice().sort().join('\0') ||
    after.untrackedEntries !== initial.untrackedEntries ||
    after.onlyKnownOwnerUntracked !== true ||
    (await refs(checkout)) !== oldRefs ||
    (await remoteMain()) !== expectedMain
  )
    throw new Error('Object import postconditions inconclusive; no auto rollback or retry');
  return {
    status: 'pinned-main-object-imported',
    ...base,
    targetObjectPresent: true,
    gitObjectStoreMutated: true,
    requiresSeparateOwnerApprovalForFastForward: true,
    backupVerified: false,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runOwnerMainObjectImport(parseOwnerMainImportArgs(argv));
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('OWNER_MAIN_OBJECT_IMPORT_REJECTED; never auto-retry or update source\n');
    process.exitCode = 2;
  });
}
