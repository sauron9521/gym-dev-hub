/**
 * Manual owner-controlled pin of an already verified lockfile-keyed private
 * pnpm store. Read-only by default, never provisions/downloads packages.
 * Does not send signals or restart API/Web. Never emits .env values.
 */
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, realpath, readFile, mkdtemp, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeKey } from './prepare-patch-check-store.mjs';
import { storeVerified } from './launch-live-operator-readiness.mjs';
import { portsAvailable } from './launch-owner-fast-forward.mjs';
import { inspectOperatorProcesses } from './launch-operator-process-provenance.mjs';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const KEY = 'DEV_HUB_PATCH_CHECK_PNPM_STORE';
const MAX_ENV = 64 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const safePath = (value) =>
  typeof value === 'string' &&
  isAbsolute(value) &&
  resolve(value) === value &&
  !/[\r\n\0]/.test(value);
const safe = (name) => /^[A-Za-z0-9_.-]{1,100}$/.test(name);
const TRUSTED = new Set([
  'https://github.com/sauron9521/gym-dev-hub.git',
  'git@github.com:sauron9521/gym-dev-hub.git',
]);

export function parsePinArgs(args) {
  if (
    (args.length !== 3 && args.length !== 5) ||
    !['--check-only', '--confirm-private-env-pin'].includes(args[0]) ||
    !args[1].startsWith('--expected-main=') ||
    !args[2].startsWith('--operator-checkout=') ||
    (args[0] === '--check-only' && args.length !== 3) ||
    (args[0] === '--confirm-private-env-pin' &&
      (args.length !== 5 ||
        !args[3].startsWith('--expected-env-sha256=') ||
        !args[4].startsWith('--backup-parent=')))
  ) {
    throw new Error('Exact manual mode, pinned main and canonical operator checkout required');
  }
  const mode = args[0];
  const expectedMain = args[1].slice('--expected-main='.length);
  const checkout = args[2].slice('--operator-checkout='.length);
  const expectedEnvSha =
    mode === '--check-only' ? null : args[3].slice('--expected-env-sha256='.length);
  const backupParent = mode === '--check-only' ? null : args[4].slice('--backup-parent='.length);
  if (
    !SHA.test(expectedMain) ||
    !safePath(checkout) ||
    (expectedEnvSha !== null && !DIGEST.test(expectedEnvSha)) ||
    (backupParent !== null && !safePath(backupParent))
  )
    throw new Error('Invalid main/env SHA or canonical paths');
  return { mode, expectedMain, checkout, expectedEnvSha, backupParent };
}

function git(checkout, args) {
  const p = spawnSync('git', ['--no-optional-locks', '-C', checkout, ...args], {
    encoding: 'utf8',
    timeout: 12_000,
    maxBuffer: 8192,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (p.error || p.status !== 0) throw new Error('Git source provenance unavailable');
  return p.stdout.trim();
}
async function exactSource(checkout, expectedMain) {
  const gitDir = await lstat(join(checkout, '.git'));
  if (!gitDir.isDirectory() || gitDir.isSymbolicLink())
    throw new Error('Only the primary Git checkout may own the private operator env');
  if (
    (await realpath(checkout)) !== checkout ||
    git(checkout, ['rev-parse', '--show-toplevel']) !== checkout ||
    git(checkout, ['rev-parse', 'HEAD']) !== expectedMain ||
    !TRUSTED.has(git(checkout, ['remote', 'get-url', 'origin']))
  )
    throw new Error('Owner checkout is not the exact trusted pinned main');
}
async function privateDir(path, checkout) {
  if (!safePath(path) || (await realpath(path)) !== path)
    throw new Error('Backup parent not canonical');
  const st = await lstat(path);
  const rel = relative(checkout, path);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid() ||
    (st.mode & 0o077) !== 0 ||
    (rel !== '..' && !rel.startsWith('..' + sep))
  )
    throw new Error('Backup parent must be existing owner-only directory outside checkout');
}

async function stableEnv(path) {
  const st = await lstat(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    st.uid !== process.getuid() ||
    (st.mode & 0o077) !== 0 ||
    st.size < 1 ||
    st.size > MAX_ENV
  )
    throw new Error('Unsafe private env file');
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const first = await fd.stat();
    if (
      first.dev !== st.dev ||
      first.ino !== st.ino ||
      first.size !== st.size ||
      first.mtimeMs !== st.mtimeMs ||
      first.ctimeMs !== st.ctimeMs
    )
      throw new Error('Private env replaced before read');
    const bytes = await fd.readFile();
    const end = await fd.stat();
    if (
      bytes.length !== st.size ||
      end.dev !== first.dev ||
      end.ino !== first.ino ||
      end.size !== first.size ||
      end.mtimeMs !== first.mtimeMs ||
      end.ctimeMs !== first.ctimeMs
    )
      throw new Error('Private env changed during read');
    return { bytes, stat: st, sha256: hash(bytes) };
  } finally {
    await fd.close();
  }
}
export function replaceOnlyPinnedStore(bytes, target) {
  if (!safePath(target)) throw new Error('Pinned target store path invalid');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0'))
    throw new Error('Owner env must have plain UTF-8 text');
  const crlf = text.includes('\r\n');
  if (crlf && text.replace(/\r\n/g, '').includes('\n'))
    throw new Error('Mixed env line endings unsafe');
  const lines = text.split(crlf ? '\r\n' : '\n');
  // Reject duplicate store keys disguised with export or spaces.
  const declared = lines.flatMap((line, i) =>
    /^\s*(?:export\s+)?DEV_HUB_PATCH_CHECK_PNPM_STORE\s*=/.test(line) ? [i] : [],
  );
  const candidates = lines.flatMap((line, i) => (line.startsWith(KEY + '=') ? [i] : []));
  if (
    declared.length !== 1 ||
    declared[0] !== candidates[0] ||
    candidates.length !== 1 ||
    !lines[candidates[0]].slice(KEY.length + 1).trim() ||
    /[\r\n]/.test(target)
  )
    throw new Error('Owner env must contain exactly one existing pinned store key');
  const previous = lines[candidates[0]].slice(KEY.length + 1);
  const replacement = KEY + '=' + target;
  lines[candidates[0]] = replacement;
  const result = Buffer.from(lines.join(crlf ? '\r\n' : '\n'), 'utf8');
  return { updated: result, changed: previous !== target };
}

async function writePrivateFile(path, bytes) {
  const f = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await f.writeFile(bytes);
    await f.sync();
  } finally {
    await f.close();
  }
}
async function syncDir(path) {
  const f = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
function operatorPorts(env) {
  const ports = [3100, 3101];
  for (const key of ['DEV_HUB_OPERATOR_API_PORT', 'DEV_HUB_OPERATOR_WEB_PORT']) {
    if (!env[key]) continue;
    if (!/^[0-9]{4,5}$/.test(env[key]) || Number(env[key]) < 1024 || Number(env[key]) > 65535)
      throw new Error('Invalid operator port setting');
    ports.push(Number(env[key]));
  }
  return ports;
}
async function stopped(checkout, ports, scan, portProbe) {
  const inventory = await scan(checkout);
  return (
    inventory?.status === 'no-known-operator-processes-at-scan-time' &&
    inventory.totalBlocking === 0 &&
    (await portProbe(ports))
  );
}

/** Store verifier and process probes may be substituted ONLY in disposable tests. */
export async function runOwnerPin({
  mode,
  checkout,
  expectedMain,
  expectedEnvSha = null,
  backupParent = null,
  verify = storeVerified,
  scan = inspectOperatorProcesses,
  portProbe = portsAvailable,
  ports = operatorPorts(process.env),
}) {
  if (process.platform !== 'linux' || process.getuid?.() === 0)
    throw new Error('Owner pin requires nonroot Linux');
  if (
    !safePath(checkout) ||
    !SHA.test(expectedMain) ||
    ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT'].some(
      (x) => process.env[x],
    )
  )
    throw new Error('Untrusted checkout or Git environment');
  await exactSource(checkout, expectedMain);
  const lock = await readFile(join(checkout, 'pnpm-lock.yaml'));
  const target = join(checkout, 'apps/api/.local/patch-check-pnpm-stores', storeKey(lock));
  const verified = await verify(target, lock);
  if (verified?.verified !== true)
    throw new Error('Pinned store missing, mismatched, or digest-unsafe');
  const envPath = join(checkout, 'apps/api/.env');
  const original = await stableEnv(envPath);
  const edit = replaceOnlyPinnedStore(original.bytes, target);
  if (mode === '--check-only')
    return {
      status: edit.changed ? 'verified-store-pin-update-required' : 'verified-store-already-pinned',
      targetStorePath: target,
      targetStoreContentVerified: true,
      envSha256: original.sha256,
      targetLockfileKey: storeKey(lock),
      privateEnvChanged: false,
      runtimeRestarted: false,
      auditChanged: false,
    };
  if (
    mode !== '--confirm-private-env-pin' ||
    !DIGEST.test(expectedEnvSha ?? '') ||
    expectedEnvSha !== original.sha256 ||
    !safePath(backupParent)
  )
    throw new Error('Private operator env change not independently owner-confirmed');
  if (!edit.changed)
    return {
      status: 'already-pinned-no-write',
      privateEnvChanged: false,
      runtimeRestarted: false,
      auditChanged: false,
    };
  await privateDir(backupParent, checkout);
  if (!(await stopped(checkout, ports, scan, portProbe)))
    throw new Error('Cannot update operator env with active or unverified Hub processes');
  // Preserve the entire original private .env, never print or publish it.
  const snapshot = await mkdtemp(join(backupParent, 'operator-env-store-pin-'));
  await writePrivateFile(join(snapshot, 'env.before'), original.bytes);
  await syncDir(snapshot);
  await syncDir(backupParent);
  const again = await stableEnv(envPath);
  if (
    again.sha256 !== original.sha256 ||
    again.stat.ino !== original.stat.ino ||
    (await realpath(envPath)) !== envPath ||
    !(await stopped(checkout, ports, scan, portProbe))
  )
    throw new Error('Owner private config or runtime changed; private backup retained');
  await exactSource(checkout, expectedMain);
  const updated = edit.updated;
  const tempPath = join(dirname(envPath), '.env.pin-store-' + randomBytes(12).toString('hex'));
  try {
    await writePrivateFile(tempPath, updated);
    const temp = await stableEnv(tempPath);
    if (temp.sha256 !== hash(updated)) throw new Error('Prepared private config failed checksum');
    const last = await stableEnv(envPath);
    if (
      last.sha256 !== original.sha256 ||
      last.stat.ino !== original.stat.ino ||
      !(await stopped(checkout, ports, scan, portProbe))
    )
      throw new Error('Owner runtime or private env changed before atomic replace');
    await rename(tempPath, envPath);
    await syncDir(dirname(envPath));
  } finally {
    await unlink(tempPath).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  const after = await stableEnv(envPath);
  if (after.sha256 !== hash(updated))
    throw new Error('Private pin postcondition uncertain; owner must inspect backup');
  return {
    status: 'private-pinned-store-config-updated-restart-required',
    backupDirectory: snapshot,
    targetLockfileKey: storeKey(lock),
    privateEnvChanged: true,
    runtimeRestarted: false,
    auditChanged: false,
  };
}
export async function main(args = process.argv.slice(2)) {
  const result = await runOwnerPin(parsePinArgs(args));
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(
      'OWNER_STORE_PIN_REJECTED; inspect private lockfile store and owner gates\n',
    );
    process.exitCode = 2;
  });
}
