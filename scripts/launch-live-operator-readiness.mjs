/**
 * Read-only operator readiness preflight for launch #107.
 * Does not authorize checks, contact GitHub, change git, start/stop Docker
 * containers, create directories, read raw audit or print credentials/paths.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectStore, POLICY, storeKey } from './prepare-patch-check-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const STORE_SHA = /^[0-9a-f]{64}$/;
const TRUSTED = new Set([
  'https://github.com/sauron9521/gym-dev-hub.git',
  'git@github.com:sauron9521/gym-dev-hub.git',
]);
const GATES = [
  'DEV_HUB_ENABLE_PATCH_CHECKS',
  'DEV_HUB_ENABLE_PATCH_REVIEW',
  'DEV_HUB_ENABLE_PATCH_APPLY',
  'DEV_HUB_ENABLE_PATCH_PREFLIGHT',
  'DEV_HUB_ENABLE_SCOPED_CODE_READ',
  'DEV_HUB_ENABLE_WORKTREE_MOUNT',
];
const SECRET_KEYS = [
  'DEV_HUB_PATCH_CHECK_OPERATOR_SECRET',
  'DEV_HUB_PATCH_APPLY_OPERATOR_SECRET',
  'DEV_HUB_WORKTREE_OPERATOR_SECRET',
];

export function parseReadinessArgs(argv) {
  if (
    argv.length !== 2 ||
    !argv[0].startsWith('--expected-main=') ||
    !argv[1].startsWith('--operator-checkout=')
  ) {
    throw new Error('Expected --expected-main=<40-digit-sha> --operator-checkout=<absolute-path>');
  }
  const expected = argv[0].slice('--expected-main='.length);
  const checkout = argv[1].slice('--operator-checkout='.length);
  if (
    !SHA.test(expected) ||
    !isAbsolute(checkout) ||
    resolve(checkout) !== checkout ||
    /[\r\n\0]/.test(checkout)
  )
    throw new Error('Invalid main pin or checkout path');
  return { expected, checkout };
}

export function checkOperatorConfig(
  env,
  host = { platform: process.platform, uid: process.getuid?.(), node: process.versions.node },
) {
  const reasons = [];
  if (host.platform !== 'linux' || host.uid === 0 || Number(host.node.split('.')[0]) < 24)
    reasons.push('unsupported-nonroot-linux-node-host');
  for (const key of GATES) {
    if (env[key] !== 'true') reasons.push('required-feature-gate-disabled');
  }
  const secrets = SECRET_KEYS.map((key) => env[key] ?? '');
  if (
    secrets.some(
      (secret) => Buffer.byteLength(secret, 'utf8') < 32 || Buffer.byteLength(secret, 'utf8') > 256,
    )
  )
    reasons.push('operator-credential-missing-or-invalid');
  if (
    secrets.every((secret) => secret.length >= 32) &&
    new Set(secrets.map((value) => createHash('sha256').update(value).digest('hex'))).size !==
      secrets.length
  )
    reasons.push('operator-credentials-not-independent');
  if (!SHA256.test(env.DEV_HUB_PATCH_CHECK_IMAGE_ID ?? '')) reasons.push('pinned-image-invalid');
  if (
    ['DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].some((key) => !!env[key]) ||
    (env.DOCKER_HOST && env.DOCKER_HOST !== 'unix:///var/run/docker.sock') ||
    (env.DOCKER_CONTEXT && env.DOCKER_CONTEXT !== 'default')
  )
    reasons.push('remote-docker-configuration-denied');
  return [...new Set(reasons)];
}

export function summarizeReadiness(reasons, checks = []) {
  return {
    status: reasons.length ? 'blocked' : 'prerequisites-checked-only',
    reasons: [...new Set(reasons)].sort(),
    checks: [...new Set(checks)].sort(),
    mayConsiderManualOwnerAuthorization: reasons.length === 0,
    realOperatorRuntimeVersionVerified: false,
    approvedWorktreeVerified: false,
    productionGrantIssued: false,
    dockerRecipeExecuted: false,
    productionAuditWritten: false,
    processRestarted: false,
    anyMutationPerformed: false,
  };
}

function safeGit(root, args) {
  const p = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 8192,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (p.error || p.status !== 0) throw new Error('Git metadata unavailable');
  return p.stdout.trim();
}
async function checkedRepository(root) {
  const stat = await lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    safeGit(root, ['rev-parse', '--show-toplevel']) !== root
  )
    throw new Error('Not an independent canonical Git checkout');
  return {
    sha: safeGit(root, ['rev-parse', 'HEAD']),
    trusted: TRUSTED.has(safeGit(root, ['remote', 'get-url', 'origin'])),
  };
}

/** Existing state only: never mkdir, chmod, fsync or update a production journal. */
export async function checkPrivateAuditDir(dir) {
  if (!dir || !isAbsolute(dir) || resolve(dir) !== dir) return false;
  try {
    const [stat, real] = await Promise.all([lstat(dir), realpath(dir)]);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      real !== dir ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0
    )
      return false;
    const file = join(dir, 'audit.jsonl');
    const metadata = await lstat(file).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    return (
      !metadata ||
      (metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.nlink === 1 &&
        metadata.uid === process.getuid() &&
        (metadata.mode & 0o077) === 0)
    );
  } catch {
    return false;
  }
}

async function privateManifest(path) {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 4096
  )
    throw new Error('Unsafe manifest metadata');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const observed = await handle.stat();
    if (observed.dev !== stat.dev || observed.ino !== stat.ino || observed.size !== stat.size)
      throw new Error('Manifest changed before read');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}
export async function storeVerified(configured, lock) {
  if (!configured || !isAbsolute(configured) || resolve(configured) !== configured)
    return { reason: 'pinned-store-path-invalid' };
  const key = storeKey(lock);
  if (!STORE_SHA.test(basename(configured)) || basename(configured) !== key)
    return { reason: 'pinned-store-lockfile-mismatch' };
  try {
    const manifest = await privateManifest(configured + '.json');
    if (
      manifest.protocol !== 2 ||
      manifest.storeKey !== key ||
      manifest.lockSha256 !== createHash('sha256').update(lock).digest('hex') ||
      manifest.pnpmVersion !== POLICY.pnpmVersion ||
      JSON.stringify(manifest.targetPlatforms) !== JSON.stringify(POLICY.targetPlatforms) ||
      !STORE_SHA.test(manifest.storeDigest ?? '') ||
      !Number.isSafeInteger(manifest.files) ||
      !Number.isSafeInteger(manifest.bytes)
    )
      return { reason: 'pinned-store-manifest-invalid' };
    const inventory = await inspectStore(configured);
    if (
      inventory.digest !== manifest.storeDigest ||
      inventory.files !== manifest.files ||
      inventory.bytes !== manifest.bytes
    )
      return { reason: 'pinned-store-content-mismatch' };
    return { verified: true };
  } catch {
    return { reason: 'pinned-store-unreadable-or-unsafe' };
  }
}
function dockerCommand(args) {
  const run = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 8192,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  if (run.error || run.status !== 0) throw new Error('Docker local query unavailable');
  return run.stdout.trim();
}
async function dockerVerified(env) {
  try {
    const socket = await lstat('/var/run/docker.sock');
    if (
      !socket.isSocket() ||
      (socket.mode & 0o007) !== 0 ||
      dockerCommand(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']) !==
        'unix:///var/run/docker.sock' ||
      dockerCommand(['info', '--format', '{{.OSType}}']) !== 'linux'
    )
      return false;
    const details = dockerCommand([
      'image',
      'inspect',
      'gym-dev-hub-node-runner:v1',
      '--format',
      '{{.Id}}|{{.Config.User}}|{{.Os}}|{{.Architecture}}|{{index .Config.Labels "org.gym-dev-hub.runner.execution"}}|{{json .Config.Entrypoint}}',
    ]);
    const [id, uid, os, architecture, execution, entry] = details.split('|');
    return (
      details.split('|').length === 6 &&
      id === env.DEV_HUB_PATCH_CHECK_IMAGE_ID &&
      uid === '65534:65534' &&
      os === 'linux' &&
      architecture === 'amd64' &&
      execution === 'disabled' &&
      entry === '["/usr/bin/node","/opt/gym-dev-hub/runner.mjs"]'
    );
  } catch {
    return false;
  }
}

export async function evaluateOperatorReadiness(expected, checkout, env = process.env) {
  const reasons = checkOperatorConfig(env);
  const checks = [];
  try {
    const source = await checkedRepository(ROOT);
    const runningCheckout = await checkedRepository(checkout);
    if (!source.trusted || source.sha !== expected)
      reasons.push('examined-source-does-not-match-pinned-main');
    else checks.push('examined-source-pinned');
    if (!runningCheckout.trusted || runningCheckout.sha !== expected)
      reasons.push('operator-checkout-behind-pinned-main');
    else checks.push('operator-checkout-at-pinned-main');
  } catch {
    reasons.push('git-checkout-unverified');
  }

  for (const [kind, key] of [
    ['docker-check', 'DEV_HUB_PATCH_CHECK_STATE_DIR'],
    ['patch-apply', 'DEV_HUB_PATCH_APPLY_STATE_DIR'],
  ]) {
    if (!env[key]) reasons.push(kind + '-audit-directory-not-explicit');
    else if (!(await checkPrivateAuditDir(env[key])))
      reasons.push(kind + '-audit-directory-unsafe-or-missing');
    else checks.push(kind + '-private-audit-directory');
  }
  const lock = await readFile(join(ROOT, 'pnpm-lock.yaml'));
  const store = await storeVerified(env.DEV_HUB_PATCH_CHECK_PNPM_STORE, lock);
  if (store.reason) reasons.push(store.reason);
  else checks.push('pinned-offline-store-content-verified');
  if (!(await dockerVerified(env))) reasons.push('pinned-local-docker-image-or-socket-unverified');
  else checks.push('pinned-local-docker-image-and-socket');
  return summarizeReadiness(reasons, checks);
}

export async function main(argv = process.argv.slice(2)) {
  const { expected, checkout } = parseReadinessArgs(argv);
  const report = await evaluateOperatorReadiness(expected, checkout);
  process.stdout.write(JSON.stringify(report) + '\n');
  if (report.status === 'blocked') process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(
      'OPERATOR_READINESS_FAILED; check CLI and local metadata; no secrets exposed\n',
    );
    process.exitCode = 2;
  });
}
