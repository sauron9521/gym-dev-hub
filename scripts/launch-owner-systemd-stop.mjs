/**
 * Explicit owner-controlled systemd user-service stop, after exact live process
 * identity checks. Read-only by default; no start/restart, git or Docker writes.
 * A successful stop is NOT proof of any current-main/HTTP golden workflow.
 */
import { spawnSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectInstalledRuntime, parseUserUnitShow } from './launch-systemd-runtime-preflight.mjs';
import { inspectSupervisor } from './launch-owner-operator-shutdown.mjs';
import { inspectOperatorProcesses } from './launch-operator-process-provenance.mjs';
import { portsAvailable } from './launch-owner-fast-forward.mjs';

const SHA = /^[0-9a-f]{40}$/;
const PID = /^[1-9][0-9]{0,8}$/;
const TICKS = /^[1-9][0-9]{0,19}$/;
const UNIT = 'gym-dev-hub-operator.service';
const KEYS = [
  'Id',
  'LoadState',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'MainPID',
  'WorkingDirectory',
];
const PROPERTY = '--property=' + KEYS.join(',');
const PORTS = [3100, 3101];

function canonical(path) {
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

export function parseSystemdStopArgs(argv) {
  const mode = argv[0];
  const preview = mode === '--inspect-only' && argv.length === 3;
  const commit = mode === '--confirm-owner-systemd-stop' && argv.length === 5;
  if (
    !(preview || commit) ||
    !argv[1]?.startsWith('--expected-owner-head=') ||
    !argv[2]?.startsWith('--operator-checkout=') ||
    (commit &&
      (!argv[3]?.startsWith('--supervisor-pid=') ||
        !argv[4]?.startsWith('--expected-start-ticks=')))
  )
    throw new Error('Explicit fixed systemd owner stop mode and pins required');
  const expectedOwnerHead = argv[1].slice('--expected-owner-head='.length);
  const checkout = argv[2].slice('--operator-checkout='.length);
  const pid = commit ? argv[3].slice('--supervisor-pid='.length) : null;
  const startTicks = commit ? argv[4].slice('--expected-start-ticks='.length) : null;
  if (
    !SHA.test(expectedOwnerHead) ||
    !canonical(checkout) ||
    (commit && (!PID.test(pid) || Number(pid) <= 1 || !TICKS.test(startTicks)))
  )
    throw new Error('Invalid exact owner source or supervisor identity');
  return {
    mode,
    expectedOwnerHead,
    checkout,
    pid: commit ? Number(pid) : null,
    startTicks,
  };
}

function systemctl(args, timeout = 8000) {
  const p = spawnSync('/usr/bin/systemctl', ['--user', ...args], {
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
  if (p.error || p.status !== 0)
    throw new Error(
      'Owner systemd command failed; outcome may be uncertain and must not be retried',
    );
  return p.stdout;
}
function readLiveUserUnit() {
  return parseUserUnitShow(systemctl(['show', UNIT, '--no-pager', PROPERTY]));
}

/** Only the fixed seven properties; accepts MainPID=0 solely after stop. */
export function parseStoppedUserUnit(output) {
  if (typeof output !== 'string' || output.length > 8192 || /[\r\0]/.test(output))
    throw new Error('Unsafe systemd post-stop response');
  const rows = output.trimEnd().split('\n');
  if (rows.length !== KEYS.length) throw new Error('Incomplete systemd post-stop response');
  const fields = new Map();
  for (const row of rows) {
    const at = row.indexOf('=');
    const name = row.slice(0, at);
    if (at < 1 || !KEYS.includes(name) || fields.has(name))
      throw new Error('Unexpected systemd post-stop field');
    fields.set(name, row.slice(at + 1));
  }
  if (
    fields.get('Id') !== UNIT ||
    fields.get('LoadState') !== 'loaded' ||
    fields.get('ActiveState') !== 'inactive' ||
    fields.get('SubState') !== 'dead' ||
    fields.get('UnitFileState') !== 'enabled' ||
    fields.get('MainPID') !== '0' ||
    !canonical(fields.get('WorkingDirectory'))
  )
    throw new Error('Systemd stop not verified; inspect state without retry');
  return { checkout: fields.get('WorkingDirectory'), status: 'inactive-dead', pid: 0 };
}
function readStoppedUserUnit() {
  return parseStoppedUserUnit(systemctl(['show', UNIT, '--no-pager', PROPERTY]));
}
function stopSystemdUserUnit() {
  // No shell, sudo, force, kill, restart, disable or no-block flags.
  systemctl(['stop', UNIT], 18000);
}

function equalLive(a, b) {
  return (
    a.id === b.id &&
    a.load === b.load &&
    a.active === b.active &&
    a.sub === b.sub &&
    a.enabled === b.enabled &&
    a.pid === b.pid &&
    a.checkout === b.checkout
  );
}
function validIdentity(identity) {
  return (
    identity?.status === 'exact-operator-supervisor-verified' &&
    identity.processOwnerVerified === true &&
    identity.scriptIdentityVerified === true &&
    identity.sourceCheckoutCanonical === true &&
    TICKS.test(identity.startTicks ?? '')
  );
}

/** Test injection is not available through CLI; production uses fixed tools. */
export async function runOwnerSystemdStop(
  { mode, expectedOwnerHead, checkout, pid = null, startTicks = null },
  {
    readLive = readLiveUserUnit,
    inspect = inspectSupervisor,
    readStopped = readStoppedUserUnit,
    stop = stopSystemdUserUnit,
    scan = inspectOperatorProcesses,
    checkPorts = portsAvailable,
  } = {},
) {
  if (process.platform !== 'linux' || process.getuid?.() === 0)
    throw new Error('Non-root Linux owner required');
  if (
    !SHA.test(expectedOwnerHead) ||
    !canonical(checkout) ||
    !['--inspect-only', '--confirm-owner-systemd-stop'].includes(mode)
  )
    throw new Error('Missing exact owner source or mode');
  const gate = await inspectInstalledRuntime(
    { expectedMain: expectedOwnerHead, checkout },
    { readUnit: readLive, inspectProcess: inspect },
  );
  if (
    gate.status !== 'source-and-process-metadata-consistent' ||
    gate.ownerHeadSha !== expectedOwnerHead ||
    gate.reasons.length
  )
    throw new Error('Current owner source or installed unit not verified');
  const unit = await readLive();
  if (
    unit.id !== UNIT ||
    unit.checkout !== checkout ||
    unit.load !== 'loaded' ||
    unit.active !== 'active' ||
    unit.sub !== 'running' ||
    unit.enabled !== 'enabled' ||
    !Number.isSafeInteger(unit.pid) ||
    unit.pid <= 1
  )
    throw new Error('Unexpected running owner service');
  const found = await inspect(checkout, unit.pid);
  if (!validIdentity(found)) throw new Error('Supervisor identity not verified');
  const confirmedUnit = await readLive();
  if (!equalLive(unit, confirmedUnit)) throw new Error('Systemd unit changed during inspection');

  const safe = {
    expectedOwnerHeadSha: expectedOwnerHead,
    supervisorPid: unit.pid,
    supervisorStartTicks: found.startTicks,
    sourceMutated: false,
    productionAuditMutated: false,
    dockerExecuted: false,
    servicesRestarted: false,
    endToEndVerified: false,
  };
  if (mode === '--inspect-only') {
    if (pid !== null || startTicks !== null) throw new Error('Preview must be read-only');
    return {
      status: 'owner-systemd-stop-inspect-only',
      ...safe,
      stopRequested: false,
      stopVerified: false,
    };
  }
  if (
    !Number.isSafeInteger(pid) ||
    pid !== unit.pid ||
    !TICKS.test(startTicks ?? '') ||
    startTicks !== found.startTicks
  )
    throw new Error('Stale owner stop approval; exact PID/birthtime mismatch');

  // Validate both source and process identity again immediately before stop.
  const finalGate = await inspectInstalledRuntime(
    { expectedMain: expectedOwnerHead, checkout },
    { readUnit: readLive, inspectProcess: inspect },
  );
  const finalUnit = await readLive();
  const lastIdentity = await inspect(checkout, pid);
  if (
    finalGate.status !== 'source-and-process-metadata-consistent' ||
    !equalLive(unit, finalUnit) ||
    !validIdentity(lastIdentity) ||
    lastIdentity.startTicks !== startTicks
  )
    throw new Error('Owner service identity changed; no stop requested');

  // systemctl stop is not an atomic PID-compare-and-stop operation. A narrow
  // post-check is mandatory; on ambiguous result do not retry automatically.
  await stop();
  const stopped = await readStopped();
  if (stopped.status !== 'inactive-dead' || stopped.pid !== 0 || stopped.checkout !== checkout)
    throw new Error('Owner systemd unit stop not conclusively verified');
  const processes = await scan(checkout);
  if (
    processes?.status !== 'no-known-operator-processes-at-scan-time' ||
    processes.totalBlocking !== 0 ||
    !(await checkPorts(PORTS))
  )
    throw new Error('Hub children or ports not conclusively stopped; manual review required');
  const stableStopped = await readStopped();
  if (
    stableStopped.status !== 'inactive-dead' ||
    stableStopped.pid !== 0 ||
    stableStopped.checkout !== checkout
  )
    throw new Error('Unit restarted or changed after child scan; manual inspection required');
  return {
    status: 'owner-systemd-stop-verified',
    ...safe,
    stopRequested: true,
    stopVerified: true,
    mayConsiderSeparateFastForward: true,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const request = parseSystemdStopArgs(argv);
  process.stdout.write(JSON.stringify(await runOwnerSystemdStop(request)) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(
      'OWNER_SYSTEMD_STOP_REJECTED; inspect exact owner unit and runtime, never auto-retry\n',
    );
    process.exitCode = 2;
  });
}
