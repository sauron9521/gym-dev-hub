/**
 * Read-only by default. Explicit --prune-stale removes ONLY stopped, >24h old
 * Docker containers with exact Hub provisioning scope/checkout/phase labels,
 * correct image entrypoint, isolation, and UUID name. Never uses docker rm -f.
 * Does NOT remove staging directories or any user's unrelated containers.
 */
import { spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkLocalDocker,
  PROVISIONING_LABEL,
  PROVISIONING_SCOPE,
  PROVISIONING_PHASE_LABEL,
  PROVISIONING_CHECKOUT_LABEL,
  PROVISIONING_CHECKOUT,
} from './provision-pinned-api-local.mjs';
import {
  stageRecoveryReport,
  pruneVerifiedStages,
  pruneStaleRunLock,
} from './pinned-stage-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = join(ROOT, '.local', 'pinned-api-runner');
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PHASE_NAMES = Object.freeze({
  stage: new RegExp('^/gym-devhub-pinned-stage-' + UUID + '$'),
  'offline-smoke': new RegExp('^/gym-devhub-provision-check-' + UUID + '$'),
});
const SHA256 = /^[a-f0-9]{64}$/;
const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT = 256 * 1024;

/** Pure classifier: refuses foreign/active/recent/modified containers. */
export function classifyProvisionContainer(item, now = Date.now()) {
  const ineligible = (reason) => ({ removable: false, reason });
  if (!item || typeof item !== 'object') return ineligible('malformed');
  const labels = item.Config?.Labels ?? {};
  if (
    labels[PROVISIONING_LABEL] !== PROVISIONING_SCOPE ||
    labels[PROVISIONING_CHECKOUT_LABEL] !== PROVISIONING_CHECKOUT
  )
    return ineligible('foreign-checkout-or-scope');
  const phase = labels[PROVISIONING_PHASE_LABEL];
  if (!Object.hasOwn(PHASE_NAMES, phase) || !PHASE_NAMES[phase].test(item.Name ?? '')) {
    return ineligible('unknown-phase-or-name');
  }
  if (!SHA256.test(item.Id ?? '')) return ineligible('invalid-container-identity');
  const createdAt = Date.parse(item.Created ?? '');
  if (!Number.isFinite(createdAt) || now - createdAt < STALE_MS) {
    return ineligible('recent-or-invalid-created-at');
  }
  if (
    !['exited', 'created'].includes(item.State?.Status) ||
    item.State?.Running !== false ||
    item.State?.Paused === true ||
    item.State?.Restarting === true
  )
    return ineligible('running-or-unexpected-state');
  const cfg = item.Config ?? {};
  const host = item.HostConfig ?? {};
  const mounts = item.Mounts ?? [];
  const caps =
    Array.isArray(host.CapDrop) &&
    host.CapDrop.length === 1 &&
    String(host.CapDrop[0]).toUpperCase() === 'ALL';
  if (
    cfg.User !== '65534:65534' ||
    host.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    host.IpcMode !== 'none' ||
    !caps ||
    !Array.isArray(host.SecurityOpt) ||
    !host.SecurityOpt.some((value) => String(value).startsWith('no-new-privileges')) ||
    (host.RestartPolicy?.Name && host.RestartPolicy.Name !== 'no')
  )
    return ineligible('unexpected-isolation');
  if (phase === 'stage') {
    if (
      host.NetworkMode !== 'bridge' ||
      host.PidsLimit !== 256 ||
      host.Memory !== 5368709120 ||
      host.NanoCpus !== 2000000000 ||
      cfg.Labels['org.gym-dev-hub.provisioner.mode'] !== 'fixed-pinned-source-only' ||
      JSON.stringify(cfg.Entrypoint) !== '["/bin/sh","/opt/gym-dev-hub/stage-pinned-api.sh"]' ||
      mounts.length !== 1 ||
      mounts[0].Type !== 'bind' ||
      mounts[0].Destination !== '/bundle' ||
      mounts[0].RW !== true
    )
      return ineligible('unexpected-stage-identity');
  } else if (
    host.NetworkMode !== 'none' ||
    host.PidsLimit !== 128 ||
    host.Memory !== 5368709120 ||
    host.NanoCpus !== 2000000000 ||
    cfg.Labels['org.gym-dev-hub.runner.execution'] !== 'disabled' ||
    JSON.stringify(cfg.Entrypoint) !== '["/usr/bin/node"]' ||
    JSON.stringify(cfg.Cmd) !== '["/opt/gym-dev-hub/api-typecheck-local.mjs"]' ||
    mounts.length !== 4 ||
    mounts.some((entry) => entry.Type !== 'bind' || entry.RW !== false) ||
    mounts
      .map((entry) => entry.Destination)
      .sort()
      .join(',') !== '/engine,/manifest,/source,/store'
  )
    return ineligible('unexpected-offline-identity');
  return { removable: true, reason: 'stopped-and-stale', phase };
}

function cleanEnv() {
  const allow = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ];
  return Object.fromEntries(
    allow.filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
  );
}

function docker(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('docker', args, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let byteCount = 0;
    let timedOut = false;
    const stop = () => {
      timedOut = true;
      child.kill();
    };
    const timeout = setTimeout(stop, 90000);
    child.stdout.on('data', (chunk) => {
      byteCount += chunk.length;
      if (byteCount > MAX_OUTPUT) stop();
      else stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      byteCount += chunk.length;
      if (byteCount > MAX_OUTPUT) stop();
    });
    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolveRun(stdout.trim());
    };
    child.on('error', () => done(new Error('Local Docker executable unavailable')));
    child.on('close', (code) =>
      done(
        timedOut || code !== 0
          ? new Error('Docker recovery inspection or safe remove failed')
          : undefined,
      ),
    );
  });
}

async function ownedContainers(now) {
  const rawIds = await docker([
    'ps',
    '--all',
    '--quiet',
    '--no-trunc',
    '--filter',
    'label=' + PROVISIONING_LABEL + '=' + PROVISIONING_SCOPE,
    '--filter',
    'label=' + PROVISIONING_CHECKOUT_LABEL + '=' + PROVISIONING_CHECKOUT,
  ]);
  const ids = rawIds ? rawIds.split(/\r?\n/) : [];
  if (ids.length > 128 || ids.some((id) => !SHA256.test(id))) {
    throw new Error('Untrusted or excessive Docker recovery inventory');
  }
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new Error('Duplicate Docker inventory IDs');
  const candidates = [];
  for (const id of ids) {
    const snapshot = JSON.parse(await docker(['inspect', '--format', '{{json .}}', id]));
    if (snapshot.Id !== id) throw new Error('Docker recovery identity mismatch');
    candidates.push({ id, snapshot, policy: classifyProvisionContainer(snapshot, now) });
  }
  return candidates;
}

async function stagedDirectories(now) {
  let entries;
  try {
    const rootStat = await lstat(LOCAL);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Unsafe local provisioning root');
    }
    entries = await readdir(LOCAL, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => /^stage-[A-Za-z0-9_-]{6}$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      type: entry.isSymbolicLink()
        ? 'symlink-not-touched'
        : entry.isDirectory()
          ? 'unpublished-staging-not-touched'
          : 'unrecognized-not-touched',
    }));
}

async function inventory() {
  const startedAt = Date.now();
  await checkLocalDocker();
  const enginePreflightMs = Date.now() - startedAt;
  const now = Date.now();
  const containers = await ownedContainers(now);
  return {
    event: 'pinned-provisioning-recovery-preview',
    scope: PROVISIONING_SCOPE,
    enginePreflightMs,
    containers: containers.map(({ snapshot, policy }) => ({
      id: snapshot.Id.slice(0, 12),
      name: snapshot.Name.slice(1),
      phase: snapshot.Config.Labels[PROVISIONING_PHASE_LABEL] ?? 'unknown',
      state: snapshot.State?.Status,
      removable: policy.removable,
      reason: policy.reason,
    })),
    stagedDirectories: await stagedDirectories(now),
    ownedStageRecords: await stageRecoveryReport(LOCAL, PROVISIONING_CHECKOUT, now).catch(
      (error) => {
        if (error?.code === 'ENOENT') return [];
        throw error;
      },
    ),
    protectedPublishedBundles: true,
    unrelatedContainersTouched: false,
    stagedDirectoriesRemoved: false,
  };
}

async function cleanup() {
  await checkLocalDocker();
  const candidates = await ownedContainers(Date.now());
  const removed = [];
  const skipped = [];
  for (const { id, snapshot, policy } of candidates) {
    if (!policy.removable) {
      skipped.push({ id: id.slice(0, 12), reason: policy.reason });
      continue;
    }
    // Reinspect immediately before a non-forced removal; if container started,
    // the classifier denies it and docker rm (without --force) also refuses.
    const again = JSON.parse(await docker(['inspect', '--format', '{{json .}}', id]));
    const latest = classifyProvisionContainer(again, Date.now());
    if (
      again.Id !== id ||
      again.Name !== snapshot.Name ||
      again.Created !== snapshot.Created ||
      !latest.removable
    ) {
      skipped.push({ id: id.slice(0, 12), reason: 'changed-since-preview' });
      continue;
    }
    await docker(['rm', id]); // No --force. Never stop, kill, or prune a running job.
    removed.push(id.slice(0, 12));
  }
  // Never try recursive stage deletion while any owned provisioning Docker
  // container is active; recheck after the non-forced container cleanup.
  const remaining = await ownedContainers(Date.now());
  const hasActive = remaining.some(
    ({ snapshot }) =>
      snapshot.State?.Running !== false || !['exited', 'created'].includes(snapshot.State?.Status),
  );
  let stageCleanup = { removed: [], skipped: [] };
  let staleLockRemoved = false;
  try {
    stageCleanup = await pruneVerifiedStages(LOCAL, PROVISIONING_CHECKOUT, hasActive);
    staleLockRemoved = await pruneStaleRunLock(LOCAL, PROVISIONING_CHECKOUT, hasActive);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return {
    event: 'pinned-provisioning-stale-container-cleanup',
    removed,
    skipped,
    stageCleanup,
    staleRunLockRemoved: staleLockRemoved,
    stagedDirectoriesRemoved: stageCleanup.removed.length > 0,
    protectedPublishedBundles: true,
    unrelatedContainersTouched: false,
  };
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--status', '--prune-stale'].includes(mode))
    throw new Error('Use --status (read-only) or --prune-stale (explicit, stopped >24h only)');
  const result = mode === '--status' ? await inventory() : await cleanup();
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      'Pinned recovery refused: ' +
        (error instanceof Error ? error.message.slice(0, 260) : 'unknown') +
        '\n',
    );
    process.exitCode = 1;
  });
}
