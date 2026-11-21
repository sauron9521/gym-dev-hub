/**
 * Exact owner-controlled pin of the EXISTING audit directories. Never moves,
 * replaces, resets or truncates their journals. Read-only unless the owner
 * explicitly approves a private .env-only atomic update during downtime.
 */
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, realpath, readFile, mkdtemp, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portsAvailable } from './launch-owner-fast-forward.mjs';
import { inspectOperatorProcesses } from './launch-operator-process-provenance.mjs';

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_ENV = 64 * 1024;
const MAX_AUDIT = 1_048_576;
const MAX_LINE = 1_200;
const AUDITS = Object.freeze([
  ['DEV_HUB_PATCH_CHECK_STATE_DIR', 'patch-checks'],
  ['DEV_HUB_PATCH_APPLY_STATE_DIR', 'patch-apply'],
]);
const TRUSTED = new Set([
  'https://github.com/sauron9521/gym-dev-hub.git',
  'git@github.com:sauron9521/gym-dev-hub.git',
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (p) =>
  typeof p === 'string' && isAbsolute(p) && resolve(p) === p && !/[\r\n\0]/.test(p);

export function parseAuditPinArgs(args) {
  if (
    (args.length !== 3 && args.length !== 5) ||
    !['--check-only', '--confirm-private-audit-pin'].includes(args[0]) ||
    !args[1].startsWith('--expected-main=') ||
    !args[2].startsWith('--operator-checkout=') ||
    (args[0] === '--check-only' && args.length !== 3) ||
    (args[0] === '--confirm-private-audit-pin' &&
      (args.length !== 5 ||
        !args[3].startsWith('--expected-env-sha256=') ||
        !args[4].startsWith('--backup-parent=')))
  )
    throw new Error('Exact read-only or separately approved owner audit pin is required');
  const mode = args[0];
  const expectedMain = args[1].slice('--expected-main='.length);
  const checkout = args[2].slice('--operator-checkout='.length);
  const expectedEnvSha =
    mode === '--check-only' ? null : args[3].slice('--expected-env-sha256='.length);
  const backupParent = mode === '--check-only' ? null : args[4].slice('--backup-parent='.length);
  if (
    !SHA.test(expectedMain) ||
    !canonical(checkout) ||
    (expectedEnvSha !== null && !HASH.test(expectedEnvSha)) ||
    (backupParent !== null && !canonical(backupParent))
  )
    throw new Error('Invalid canonical owner checkout or pinned SHA');
  return { mode, expectedMain, checkout, expectedEnvSha, backupParent };
}

function git(root, args) {
  const p = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], {
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
  if (p.error || p.status !== 0) throw new Error('Git owner source provenance unavailable');
  return p.stdout.trim();
}
async function exactSource(checkout, expectedMain) {
  const meta = await lstat(join(checkout, '.git'));
  if (
    (await realpath(checkout)) !== checkout ||
    !meta.isDirectory() ||
    meta.isSymbolicLink() ||
    git(checkout, ['rev-parse', '--show-toplevel']) !== checkout ||
    git(checkout, ['rev-parse', 'HEAD']) !== expectedMain ||
    !TRUSTED.has(git(checkout, ['remote', 'get-url', 'origin']))
  )
    throw new Error('Actual primary checkout must be at an externally pinned trusted main');
}
async function privateDirectory(path) {
  if (!canonical(path) || (await realpath(path)) !== path)
    throw new Error('Untrusted audit or backup directory path');
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid() ||
    (s.mode & 0o077) !== 0
  )
    throw new Error('Expected an existing owner-only 0700 directory');
}
async function privateFile(path, maxBytes, allowEmpty = false) {
  const s = await lstat(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1 ||
    s.uid !== process.getuid() ||
    (s.mode & 0o077) !== 0 ||
    (!allowEmpty && s.size === 0) ||
    s.size > maxBytes
  )
    throw new Error('Private audit or env file is unsafe');
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await fd.stat();
    if (
      before.dev !== s.dev ||
      before.ino !== s.ino ||
      before.size !== s.size ||
      before.mtimeMs !== s.mtimeMs ||
      before.ctimeMs !== s.ctimeMs
    )
      throw new Error('Private file changed before read');
    const bytes = await fd.readFile();
    const after = await fd.stat();
    if (
      bytes.length !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('Private file changed during read');
    return { bytes, sha256: hash(bytes), ino: before.ino };
  } finally {
    await fd.close();
  }
}
export async function inspectOwnerAudits(checkout) {
  const root = join(checkout, 'apps/api/.local');
  await privateDirectory(root);
  const result = [];
  for (const [key, basename] of AUDITS) {
    const dir = join(root, basename);
    await privateDirectory(dir);
    const file = join(dir, 'audit.jsonl');
    const report = await privateFile(file, MAX_AUDIT);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(report.bytes);
    if (!text.endsWith('\n')) throw new Error('Truncated existing audit journal');
    const lines = text.slice(0, -1).split('\n');
    if (!lines.length || lines.length > 2000)
      throw new Error('Invalid private journal record count');
    for (const line of lines) {
      if (!line || Buffer.byteLength(line, 'utf8') > MAX_LINE)
        throw new Error('Unsafe private audit record boundary');
      const record = JSON.parse(line);
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        typeof record.at !== 'string' ||
        typeof record.event !== 'string'
      )
        throw new Error('Existing audit entry cannot be validated');
    }
    result.push({ key, path: dir, records: lines.length, sha256: report.sha256 });
  }
  return result;
}

export function addOnlyMissingAuditPins(bytes, paths) {
  const source = bytes.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(bytes) || source.includes('\0'))
    throw new Error('Private env is not plain UTF-8');
  const crlf = source.includes('\r\n');
  if (crlf && source.replace(/\r\n/g, '').includes('\n'))
    throw new Error('Mixed .env line endings');
  const newline = crlf ? '\r\n' : '\n';
  const lines = source.split(newline);
  const additions = [];
  for (const [key] of AUDITS) {
    const declared = lines.filter((line) =>
      new RegExp('^\\s*(?:export\\s+)?' + key + '\\s*=').test(line),
    );
    if (declared.length > 1) throw new Error('Duplicate private audit setting');
    const current = declared[0];
    if (current !== undefined) {
      // Never silently switch from an alternate custom audit path: history
      // could be orphaned, and old grants would disappear from projections.
      if (current !== key + '=' + paths[key])
        throw new Error('Existing explicit audit setting must be preserved');
    } else {
      additions.push(key + '=' + paths[key]);
    }
  }
  if (!additions.length) return { changed: false, updated: bytes };
  const base = source.endsWith(newline) ? source : source + newline;
  const updated = Buffer.from(base + additions.join(newline) + newline, 'utf8');
  return { changed: true, updated };
}

async function createPrivate(path, bytes) {
  const fd = await open(
    path,
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
async function fsyncDir(path) {
  const fd = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function runtimeQuiet(checkout, scan, portProbe, ports) {
  const proof = await scan(checkout);
  return (
    proof?.totalBlocking === 0 &&
    proof.status === 'no-known-operator-processes-at-scan-time' &&
    (await portProbe(ports))
  );
}
function configuredPorts(env) {
  const ports = [3100, 3101];
  for (const key of ['DEV_HUB_OPERATOR_API_PORT', 'DEV_HUB_OPERATOR_WEB_PORT']) {
    const value = env[key];
    if (!value) continue;
    if (!/^[0-9]{4,5}$/.test(value) || Number(value) < 1024 || Number(value) > 65535)
      throw new Error('Untrusted operator port override');
    ports.push(Number(value));
  }
  return ports;
}
export async function runAuditPin({
  mode,
  expectedMain,
  checkout,
  expectedEnvSha = null,
  backupParent = null,
  scan = inspectOperatorProcesses,
  portProbe = portsAvailable,
  ports = configuredPorts(process.env),
}) {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() === 0 ||
    !canonical(checkout) ||
    !SHA.test(expectedMain) ||
    ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT'].some(
      (k) => process.env[k],
    )
  )
    throw new Error('Owner audit pin requires trusted nonroot Linux');
  await exactSource(checkout, expectedMain);
  const journals = await inspectOwnerAudits(checkout);
  const paths = Object.fromEntries(journals.map((j) => [j.key, j.path]));
  const envPath = join(checkout, 'apps/api/.env');
  const original = await privateFile(envPath, MAX_ENV);
  const { changed, updated } = addOnlyMissingAuditPins(original.bytes, paths);
  if (mode === '--check-only')
    return {
      status: changed
        ? 'existing-audits-require-explicit-env-pin'
        : 'existing-audits-already-explicitly-pinned',
      expectedMain,
      auditJournalsVerified: true,
      journalEntryCounts: journals.map((j) => ({
        type: j.key.includes('CHECK') ? 'docker-check' : 'patch-apply',
        records: j.records,
      })),
      envSha256: original.sha256,
      privateEnvChanged: false,
      auditJournalsChanged: false,
      runtimeRestarted: false,
    };
  if (
    mode !== '--confirm-private-audit-pin' ||
    !HASH.test(expectedEnvSha ?? '') ||
    expectedEnvSha !== original.sha256 ||
    !canonical(backupParent)
  )
    throw new Error('Explicit private audit pin confirmation missing or stale');
  if (!changed)
    return {
      status: 'audit-paths-already-pinned-no-write',
      privateEnvChanged: false,
      auditJournalsChanged: false,
      runtimeRestarted: false,
    };
  await privateDirectory(backupParent);
  const relation = relative(checkout, backupParent);
  if (relation === '' || (relation !== '..' && !relation.startsWith('..' + sep)))
    throw new Error('Private backup parent must be outside owner source');
  if (!(await runtimeQuiet(checkout, scan, portProbe, ports)))
    throw new Error('Operator must be fully stopped before private config change');

  const snapshot = await mkdtemp(join(backupParent, 'owner-audit-env-backup-'));
  await createPrivate(join(snapshot, 'env.before'), original.bytes);
  await fsyncDir(snapshot);
  await fsyncDir(backupParent);
  const verifyFresh = async () => {
    await exactSource(checkout, expectedMain);
    const latest = await privateFile(envPath, MAX_ENV);
    if (
      latest.sha256 !== original.sha256 ||
      latest.ino !== original.ino ||
      !(await runtimeQuiet(checkout, scan, portProbe, ports))
    )
      throw new Error('Owner private env or operator changed; preserve backup for inspection');
    const other = await inspectOwnerAudits(checkout);
    if (
      other.length !== journals.length ||
      other.some(
        (v, i) =>
          v.path !== journals[i].path ||
          v.sha256 !== journals[i].sha256 ||
          v.records !== journals[i].records,
      )
    )
      throw new Error('Existing audit history changed; refuse to pin while active');
  };
  await verifyFresh();
  const temp = join(dirname(envPath), '.env.audit-pin-' + randomBytes(12).toString('hex'));
  try {
    await createPrivate(temp, updated);
    const staged = await privateFile(temp, MAX_ENV);
    if (staged.sha256 !== hash(updated)) throw new Error('Failed private staged env check');
    await verifyFresh();
    await rename(temp, envPath);
    await fsyncDir(dirname(envPath));
  } finally {
    await unlink(temp).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  const after = await privateFile(envPath, MAX_ENV);
  if (after.sha256 !== hash(updated))
    throw new Error('Private env pin status uncertain; inspect owner backup');
  return {
    status: 'existing-audit-paths-pinned-restart-required',
    backupDirectory: snapshot,
    oldJournalEntriesPreserved: journals.map((j) => j.records),
    privateEnvChanged: true,
    auditJournalsChanged: false,
    runtimeRestarted: false,
  };
}
export async function main(args = process.argv.slice(2)) {
  const report = await runAuditPin(parseAuditPinArgs(args));
  process.stdout.write(JSON.stringify(report) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    process.stderr.write('OWNER_AUDIT_PIN_REJECTED; inspect journal history and owner preflight\n');
    process.exitCode = 2;
  });
