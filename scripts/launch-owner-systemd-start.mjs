/**
 * Owner-approved start of the fixed Hub systemd user service AFTER a separately
 * verified source fast-forward, dependency install and build.
 * Default is read-only; never attempts a stop/restart, Docker or Git mutation.
 */
import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSource } from './launch-source-reconcile.mjs';
import { parseStoppedUserUnit } from './launch-owner-systemd-stop.mjs';
import { parseUserUnitShow } from './launch-systemd-runtime-preflight.mjs';
import { inspectSupervisor } from './launch-owner-operator-shutdown.mjs';
import { inspectOperatorProcesses } from './launch-operator-process-provenance.mjs';
import { portsAvailable } from './launch-owner-fast-forward.mjs';

const UNIT = 'gym-dev-hub-operator.service';
const SHA = /^[0-9a-f]{40}$/;
const TICKS = /^[1-9][0-9]{0,19}$/;
const FIELDS = [
  'Id',
  'LoadState',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'MainPID',
  'WorkingDirectory',
];
const EXPECTED_DIRTY = ['apps/web/next-env.d.ts', 'turbo.json'];
const PORTS = [3100, 3101];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function absolute(path) {
  return (
    typeof path === 'string' &&
    path.length > 1 &&
    path.length <= 1024 &&
    isAbsolute(path) &&
    resolve(path) === path &&
    !/[\r\n\0]/.test(path) &&
    !path.includes('//') &&
    !path.includes('/./') &&
    !path.includes('/../')
  );
}

export function parseOwnerStartArgs(argv) {
  if (
    argv.length !== 3 ||
    !['--check-only', '--confirm-owner-systemd-start'].includes(argv[0]) ||
    !argv[1].startsWith('--expected-main=') ||
    !argv[2].startsWith('--operator-checkout=')
  )
    throw new Error('Require one fixed mode, externally pinned main and owner checkout');
  const expectedMain = argv[1].slice('--expected-main='.length);
  const checkout = argv[2].slice('--operator-checkout='.length);
  if (!SHA.test(expectedMain) || !absolute(checkout))
    throw new Error('Invalid pinned main or owner checkout');
  return { mode: argv[0], expectedMain, checkout };
}

function systemctl(args, timeout = 8000) {
  const result = spawnSync('/usr/bin/systemctl', ['--user', ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8192,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME ?? '',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? '',
    },
  });
  if (result.error || result.status !== 0)
    throw new Error('Owner systemd command failed; inspect outcome without retry');
  return result.stdout;
}
function readUnit() {
  return systemctl(['show', UNIT, '--no-pager', '--property=' + FIELDS.join(',')]);
}
function startUnit() {
  systemctl(['start', UNIT], 18_000);
}

function parseInactive(raw, checkout) {
  const unit = parseStoppedUserUnit(raw);
  if (unit.status !== 'inactive-dead' || unit.pid !== 0 || unit.checkout !== checkout)
    throw new Error('Expected installed inactive owner unit at primary checkout');
  return unit;
}
function parseActive(raw, checkout) {
  const u = parseUserUnitShow(raw);
  if (
    u.id !== UNIT ||
    u.load !== 'loaded' ||
    u.enabled !== 'enabled' ||
    u.active !== 'active' ||
    u.sub !== 'running' ||
    u.checkout !== checkout ||
    !Number.isSafeInteger(u.pid) ||
    u.pid <= 1
  )
    throw new Error('Owner unit did not become the expected active service');
  return u;
}

/** Existing primary only; never checks out or fetches source. */
export async function validatePinnedSource(checkout, expectedMain) {
  const [root, gitDir, physical] = await Promise.all([
    lstat(checkout),
    lstat(join(checkout, '.git')),
    realpath(checkout),
  ]);
  if (
    physical !== checkout ||
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== process.getuid() ||
    !gitDir.isDirectory() ||
    gitDir.isSymbolicLink()
  )
    throw new Error('Trusted physical owner primary checkout required');
  const status = inspectSource(checkout, expectedMain);
  if (
    status.status !== 'up-to-date' ||
    status.localSha !== expectedMain ||
    status.targetSha !== expectedMain ||
    status.reasons.length ||
    (status.trackedChanges !== 0 &&
      (status.trackedChanges !== 2 ||
        status.trackedPaths.slice().sort().join('\0') !== EXPECTED_DIRTY.join('\0'))) ||
    status.onlyKnownOwnerUntracked !== true
  )
    throw new Error('Owner source not at externally pinned main or has unsafe edits');
  const api = await lstat(join(checkout, 'apps/api/dist/main.js'));
  if (!api.isFile() || api.isSymbolicLink() || api.size < 1 || api.uid !== process.getuid())
    throw new Error('Built API entrypoint absent or unsafe; build required');
  return true;
}

async function httpHealth(port, path) {
  return new Promise((done) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        timeout: 1500,
        agent: false,
        headers: { Connection: 'close' },
      },
      (res) => {
        const ok = res.statusCode === 200;
        res.destroy();
        done(ok);
      },
    );
    req.once('timeout', () => req.destroy());
    req.once('error', () => done(false));
    req.end();
  });
}
async function fixedHealth() {
  const [api, web] = await Promise.all([httpHealth(3101, '/health/live'), httpHealth(3100, '/')]);
  return api && web;
}

function exactProcess(x) {
  return (
    x?.status === 'exact-operator-supervisor-verified' &&
    x.sourceCheckoutCanonical === true &&
    x.processOwnerVerified === true &&
    x.scriptIdentityVerified === true &&
    TICKS.test(x.startTicks ?? '')
  );
}

/** Dependencies are injectable solely for disposable hermetic tests. */
export async function runOwnerSystemdStart(
  { mode, expectedMain, checkout },
  {
    source = validatePinnedSource,
    unit = readUnit,
    processes = inspectOperatorProcesses,
    freePorts = portsAvailable,
    start = startUnit,
    inspect = inspectSupervisor,
    health = fixedHealth,
    sleep = wait,
    maxChecks = 12,
  } = {},
) {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() === 0 ||
    !absolute(checkout) ||
    !SHA.test(expectedMain) ||
    !['--check-only', '--confirm-owner-systemd-start'].includes(mode)
  )
    throw new Error('Non-root Linux, fixed mode, owner source and full pinned SHA required');

  const checkStopped = async () => {
    await source(checkout, expectedMain);
    const a = parseInactive(await unit(), checkout);
    const inventory = await processes(checkout);
    if (
      inventory?.status !== 'no-known-operator-processes-at-scan-time' ||
      inventory.totalBlocking !== 0 ||
      !(await freePorts(PORTS))
    )
      throw new Error('Hub processes or ports are not confirmed stopped');
    const b = parseInactive(await unit(), checkout);
    await source(checkout, expectedMain);
    if (a.checkout !== b.checkout) throw new Error('Systemd unit changed during inspection');
  };
  await checkStopped();
  const base = {
    expectedMainSha: expectedMain,
    sourceMutated: false,
    privateStateMutated: false,
    dockerExecuted: false,
    systemdStopRequested: false,
    endToEndVerified: false,
    loadedSourceCryptographicallyAttested: false,
  };
  if (mode === '--check-only')
    return {
      status: 'owner-systemd-start-preflight-only',
      ...base,
      systemdStartRequested: false,
      httpHealthVerified: false,
    };

  // Explicit opt-in. Recheck immediately before the sole start request.
  await checkStopped();
  await start(); // A lost response is ambiguous; no auto-retry and no auto-stop.
  if (!Number.isSafeInteger(maxChecks) || maxChecks < 1 || maxChecks > 20)
    throw new Error('Invalid bounded post-start policy');

  for (let attempt = 0; attempt < maxChecks; attempt++) {
    try {
      const a = parseActive(await unit(), checkout);
      const p = await inspect(checkout, a.pid);
      if (!exactProcess(p)) throw new Error('Supervisor identity unverified');
      const ok = await health();
      const b = parseActive(await unit(), checkout);
      const q = await inspect(checkout, b.pid);
      await source(checkout, expectedMain);
      if (ok && a.pid === b.pid && exactProcess(q) && q.startTicks === p.startTicks)
        return {
          status: 'owner-systemd-start-health-verified',
          ...base,
          systemdStartRequested: true,
          httpHealthVerified: true,
          activeSupervisorIdentityVerified: true,
          servicesRestarted: false,
        };
    } catch {
      // Health can become ready shortly after systemctl start; no second start.
    }
    if (attempt + 1 < maxChecks) await sleep(350);
  }
  throw new Error('START_OUTCOME_UNVERIFIED: no auto stop/restart/retry; inspect owner service');
}

export async function main(args = process.argv.slice(2)) {
  const result = await runOwnerSystemdStart(parseOwnerStartArgs(args));
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('OWNER_SYSTEMD_START_REJECTED; no automatic recovery or retry\n');
    process.exitCode = 2;
  });
}
