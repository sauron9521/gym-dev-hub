/**
 * Read-only exact-grant production audit receipt verification for Issue #108.
 * No Docker execution, HTTP grant issuance, env secrets, Git writes or PR.
 * A journal alone is NOT a cryptographic proof of Docker isolation.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECIPES = new Set([
  'API_FORMAT',
  'API_TYPECHECK',
  'API_TEST',
  'WEB_FORMAT',
  'WEB_TYPECHECK',
  'WEB_TEST',
]);
const EVENTS = new Set(['issued', 'attempted', 'passed', 'rejected', 'cancel-requested']);
const ORIGINS = new Set([
  'https://github.com/sauron9521/gym-dev-hub.git',
  'git@github.com:sauron9521/gym-dev-hub.git',
]);
const LIMIT = 1024 * 1024;
const LINE_LIMIT = 1200;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function parseReceiptArgs(argv) {
  const names = [
    '--check-only',
    '--expected-main=',
    '--operator-checkout=',
    '--session-id=',
    '--plan-id=',
    '--grant-id=',
    '--run-id=',
    '--recipe-id=',
  ];
  if (
    argv.length !== names.length ||
    argv[0] !== names[0] ||
    names.slice(1).some((name, i) => !argv[i + 1].startsWith(name))
  )
    throw new Error('Exact owner read-only receipt verification arguments required');
  const data = Object.fromEntries(
    names.slice(1).map((name, i) => [name.slice(2, -1), argv[i + 1].slice(name.length)]),
  );
  const checkout = data['operator-checkout'];
  if (
    !SHA.test(data['expected-main']) ||
    typeof checkout !== 'string' ||
    !isAbsolute(checkout) ||
    resolve(checkout) !== checkout ||
    !/^\/[A-Za-z0-9._/-]+$/.test(checkout) ||
    /[\r\n\0]/.test(checkout) ||
    !UUID.test(data['session-id']) ||
    !UUID.test(data['plan-id']) ||
    !UUID.test(data['grant-id']) ||
    !UUID.test(data['run-id']) ||
    !RECIPES.has(data['recipe-id'])
  )
    throw new Error('Invalid pinned SHA, canonical checkout, UUID or recipe');
  return {
    checkout,
    main: data['expected-main'],
    sessionId: data['session-id'],
    planId: data['plan-id'],
    grantId: data['grant-id'],
    runId: data['run-id'],
    recipeId: data['recipe-id'],
  };
}

function git(checkout, args) {
  const p = spawnSync('git', ['--no-optional-locks', '-C', checkout, ...args], {
    encoding: 'utf8',
    timeout: 12000,
    maxBuffer: 8192,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
    },
  });
  if (p.error || p.status !== 0) throw new Error('Trusted local owner Git unavailable');
  return p.stdout.trim();
}
async function privateDir(path) {
  const [physical, stat] = await Promise.all([realpath(path), lstat(path)]);
  if (
    physical !== path ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Untrusted existing private audit directory');
}
async function verifiedRead(file) {
  const st = await lstat(file);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    st.uid !== process.getuid() ||
    (st.mode & 0o077) !== 0 ||
    st.size < 1 ||
    st.size > LIMIT
  )
    throw new Error('Existing private audit journal unsafe');
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const first = await fd.stat();
    if (
      first.dev !== st.dev ||
      first.ino !== st.ino ||
      first.size !== st.size ||
      first.mtimeMs !== st.mtimeMs ||
      first.ctimeMs !== st.ctimeMs
    )
      throw new Error('Audit journal changed before read');
    const bytes = await fd.readFile();
    const last = await fd.stat();
    if (
      bytes.length !== first.size ||
      last.dev !== first.dev ||
      last.ino !== first.ino ||
      last.size !== first.size ||
      last.mtimeMs !== first.mtimeMs ||
      last.ctimeMs !== first.ctimeMs
    )
      throw new Error('Audit journal changed during read');
    return bytes;
  } finally {
    await fd.close();
  }
}
export function parseAuditRecords(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > LIMIT)
    throw new Error('Untrusted bounded audit bytes');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!source.endsWith('\n') || source.includes('\r'))
    throw new Error('Audit journal must be complete LF-delimited UTF-8');
  return source
    .slice(0, -1)
    .split('\n')
    .map((line) => {
      if (!line || Buffer.byteLength(line, 'utf8') > LINE_LIMIT)
        throw new Error('Invalid audit line boundaries');
      const item = JSON.parse(line);
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        !EVENTS.has(item.event) ||
        !UUID.test(item.grantId ?? '') ||
        !UUID.test(item.sessionId ?? '') ||
        !UUID.test(item.planId ?? '') ||
        !(item.runId === null || UUID.test(item.runId ?? '')) ||
        !RECIPES.has(item.recipeId) ||
        !COMMIT.test(item.sourceCommit ?? '') ||
        !HASH.test(item.sourceSha256 ?? '') ||
        !HASH.test(item.proposedSha256 ?? '') ||
        !HASH.test(item.filePathSha256 ?? '') ||
        !/^sha256:[a-f0-9]{64}$/.test(item.fingerprint ?? '') ||
        typeof item.at !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(item.at) ||
        !Number.isFinite(Date.parse(item.at))
      )
        throw new Error('Invalid private audit record schema');
      return item;
    });
}

/** No best-effort success: EXACT issued->attempted->passed, one grant and one run. */
export function verifyPassedReceipt(records, expected) {
  if (
    !Array.isArray(records) ||
    !SHA.test(expected.main) ||
    !UUID.test(expected.sessionId) ||
    !UUID.test(expected.planId) ||
    !UUID.test(expected.grantId) ||
    !UUID.test(expected.runId) ||
    !RECIPES.has(expected.recipeId)
  )
    throw new Error('Invalid pinned receipt request');
  const chain = records.filter((record) => record.grantId === expected.grantId);
  if (chain.length !== 3 || chain.map((x) => x.event).join(',') !== 'issued,attempted,passed')
    throw new Error('No unique complete passed production audit receipt');
  const [issued, attempted, passed] = chain;
  const immutable = [
    'sessionId',
    'planId',
    'recipeId',
    'sourceCommit',
    'sourceSha256',
    'proposedSha256',
    'filePathSha256',
    'fingerprint',
  ];
  if (
    issued.runId !== null ||
    attempted.runId !== expected.runId ||
    passed.runId !== expected.runId ||
    issued.sessionId !== expected.sessionId ||
    issued.planId !== expected.planId ||
    issued.recipeId !== expected.recipeId ||
    issued.sourceCommit !== expected.main ||
    records.some((r) => r.grantId !== expected.grantId && r.runId === expected.runId) ||
    [attempted, passed].some((r) => immutable.some((k) => r[k] !== issued[k]))
  )
    throw new Error('Audit grant/run identity or source drift');
  const times = chain.map((r) => Date.parse(r.at));
  if (
    times.some((t, i) => i > 0 && t < times[i - 1]) ||
    passed.containerRemoved !== true ||
    !Number.isInteger(passed.durationMs) ||
    passed.durationMs < 0 ||
    passed.durationMs > 600000 ||
    !Number.isInteger(passed.stdoutBytes) ||
    passed.stdoutBytes < 0 ||
    passed.stdoutBytes > 65536 ||
    !Number.isInteger(passed.stderrBytes) ||
    passed.stderrBytes < 0 ||
    passed.stderrBytes > 65536 ||
    passed.failureKind !== undefined
  )
    throw new Error('Audit passed terminal receipt missing durable success fields');
  return {
    status: 'verified-persisted-production-docker-receipt',
    sourceCommit: expected.main,
    sessionId: expected.sessionId,
    planId: expected.planId,
    grantId: expected.grantId,
    runId: expected.runId,
    recipeId: expected.recipeId,
    events: ['issued', 'attempted', 'passed'],
    containerRemoved: true,
    readOnly: true,
    dockerReexecuted: false,
    githubPrCreated: false,
    endToEndVerified: false,
  };
}
export async function verifyOwnerReceipt(expected) {
  if (process.platform !== 'linux' || process.getuid?.() === 0)
    throw new Error('Nonroot Linux private audit verifier required');
  const checkout = expected.checkout;
  if (
    !isAbsolute(checkout) ||
    resolve(checkout) !== checkout ||
    (await realpath(checkout)) !== checkout
  )
    throw new Error('Owner primary checkout must be canonical');
  const gitDir = await lstat(join(checkout, '.git'));
  if (
    !gitDir.isDirectory() ||
    gitDir.isSymbolicLink() ||
    git(checkout, ['rev-parse', '--show-toplevel']) !== checkout ||
    git(checkout, ['rev-parse', 'HEAD']) !== expected.main ||
    git(checkout, ['symbolic-ref', '--short', 'HEAD']) !== 'main' ||
    !ORIGINS.has(git(checkout, ['remote', 'get-url', 'origin']))
  )
    throw new Error('Owner primary checkout does not match pinned main');
  const root = join(checkout, 'apps/api/.local');
  const audit = join(root, 'patch-checks');
  await privateDir(root);
  await privateDir(audit);
  const bytes = await verifiedRead(join(audit, 'audit.jsonl'));
  const result = verifyPassedReceipt(parseAuditRecords(bytes), expected);
  return { ...result, journalSha256: sha256(bytes) };
}
export async function main(args = process.argv.slice(2)) {
  const result = await verifyOwnerReceipt(parseReceiptArgs(args));
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    process.stderr.write(
      'DOCKER_RECEIPT_NOT_VERIFIED: check exact owner SHA and production audit sequence\n',
    );
    process.exitCode = 2;
  });
