/**
 * Owner-controlled graceful stop of ONLY the exact verified Hub operator
 * supervisor. Manual opt-in only. Does not kill child processes or process
 * groups itself: dev-operator.mjs owns its API/Web shutdown policy.
 * No automatic restart, Git updates, Docker, or private environment access.
 */
import { readFile, realpath, lstat, readlink, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portsAvailable } from './launch-owner-fast-forward.mjs';
import { inspectOperatorProcesses } from './launch-operator-process-provenance.mjs';

const PID = /^[1-9][0-9]{0,8}$/;
const TICKS = /^[1-9][0-9]{0,19}$/;
const MAX_ARG_BYTES = 4096;
const MAX_STAT_BYTES = 8192;
const MAX_PROC_ENTRIES = 32768;
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_MS = 150;
const ACTIVE_STATUSES = new Set(['S', 'R', 'D', 'I', 'T', 't', 'W', 'P']);
// Polling must keep the CLI alive until shutdown is actually verified.
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

export function parseShutdownArgs(argv) {
  if (
    (argv.length !== 3 && argv.length !== 4) ||
    !['--inspect-only', '--confirm-graceful-stop'].includes(argv[0]) ||
    !argv[1].startsWith('--operator-checkout=') ||
    !argv[2].startsWith('--supervisor-pid=')
  ) {
    throw new Error('Require explicit operator checkout and exact supervisor PID');
  }
  const mode = argv[0];
  if (
    (mode === '--inspect-only' && argv.length !== 3) ||
    (mode === '--confirm-graceful-stop' && argv.length !== 4) ||
    (argv.length === 4 && !argv[3].startsWith('--expected-start-ticks='))
  ) {
    throw new Error('Owner stop requires separately verified Linux process start ticks');
  }
  const checkout = argv[1].slice('--operator-checkout='.length);
  const pid = argv[2].slice('--supervisor-pid='.length);
  const startTicks = argv.length === 4 ? argv[3].slice('--expected-start-ticks='.length) : null;
  if (
    !isAbsolute(checkout) ||
    resolve(checkout) !== checkout ||
    /[\r\n\0]/.test(checkout) ||
    !PID.test(pid) ||
    Number(pid) <= 1 ||
    (startTicks !== null && !TICKS.test(startTicks))
  )
    throw new Error('Invalid absolute checkout, PID or process identity pin');
  return { mode, checkout, pid: Number(pid), startTicks };
}

/** Read Linux /proc stat starttime (field 22) and state, never expose argv. */
export function parseSupervisorStat(statString, expectedPid) {
  if (
    typeof statString !== 'string' ||
    statString.length > MAX_STAT_BYTES ||
    !statString.startsWith(String(expectedPid) + ' (')
  )
    throw new Error('Invalid supervisor /proc stat');
  const end = statString.lastIndexOf(') ');
  if (end < 0) throw new Error('Invalid /proc comm framing');
  const fields = statString
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (
    fields.length < 20 ||
    !TICKS.test(fields[19]) ||
    !/^[A-Za-z]$/.test(fields[0]) ||
    !/^[0-9]+$/.test(fields[1])
  )
    throw new Error('Invalid supervisor process state/starttime');
  return { state: fields[0], startTicks: fields[19], parentPid: Number(fields[1]) };
}
function canonical(path) {
  return (
    typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\r\n\0]/.test(path)
  );
}
/**
 * Linux may deny cwd/exe readlink (Yama/ptrace) for a genuine same-owner
 * supervisor. Only in that case, require a direct, same-uid API child
 * executing the exact absolute script inside the expected checkout.
 * Child-parent linkage and command identity are read-only, not guessed.
 */
async function verifyDirectApiChild(procRoot, supervisorPid, checkout) {
  const entries = await readdir(procRoot, { withFileTypes: true });
  if (entries.length > MAX_PROC_ENTRIES)
    throw new Error('Process table too large for verified supervisor linkage');
  for (const entry of entries) {
    if (!entry.isDirectory() || !PID.test(entry.name)) continue;
    const candidate = join(procRoot, entry.name);
    try {
      const owner = await lstat(candidate);
      if (owner.uid !== process.getuid()) continue;
      const childStat = parseSupervisorStat(
        await readFile(join(candidate, 'stat'), 'utf8'),
        Number(entry.name),
      );
      if (childStat.parentPid !== supervisorPid || !ACTIVE_STATUSES.has(childStat.state)) continue;
      const command = await readFile(join(candidate, 'cmdline'));
      if (!command.length || command.length > MAX_ARG_BYTES || command.at(-1) !== 0) continue;
      const argv = command.toString('utf8').split('\0').filter(Boolean);
      if (
        argv.length !== 2 ||
        basename(argv[0]) !== 'node' ||
        argv[1] !== join(checkout, 'apps/api/dist/main.js')
      )
        continue;
      // Revalidate the parent-child PID relationship after reading cmdline.
      const second = parseSupervisorStat(
        await readFile(join(candidate, 'stat'), 'utf8'),
        Number(entry.name),
      );
      if (
        second.parentPid !== supervisorPid ||
        second.startTicks !== childStat.startTicks ||
        !ACTIVE_STATUSES.has(second.state)
      )
        continue;
      return true;
    } catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) continue;
      throw new Error('Cannot verify isolated direct API child');
    }
  }
  return false;
}

async function readCurrentProcess(pid) {
  let data;
  try {
    data = await readFile(join('/proc', String(pid), 'stat'), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return null;
    throw new Error('Supervisor liveness metadata unavailable');
  }
  const stat = parseSupervisorStat(data, pid);
  return stat;
}

export async function inspectSupervisor(
  checkout,
  pid,
  { procRoot = '/proc', readLink = readlink } = {},
) {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() === 0 ||
    !canonical(checkout) ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    (await realpath(checkout)) !== checkout
  )
    throw new Error('Only canonical non-root Linux operator checkout is allowed');

  const path = join(procRoot, String(pid));
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid())
    throw new Error('Process is not the current-user operator');
  const [cmdline, stats] = await Promise.all([
    readFile(join(path, 'cmdline')),
    readFile(join(path, 'stat'), 'utf8'),
  ]);
  if (!cmdline.length || cmdline.length > MAX_ARG_BYTES || cmdline.at(-1) !== 0)
    throw new Error('Supervisor command-line unsafe');
  const argv = cmdline.toString('utf8').split('\0').filter(Boolean);
  const allowedScript = new Set([
    'scripts/dev-operator.mjs',
    join(checkout, 'scripts/dev-operator.mjs'),
  ]);
  if (argv.length !== 2 || basename(argv[0]) !== 'node' || !allowedScript.has(argv[1]))
    throw new Error('PID does not identify the exact Hub operator supervisor');
  const identity = parseSupervisorStat(stats, pid);
  if (!ACTIVE_STATUSES.has(identity.state))
    throw new Error('Operator supervisor no longer running');

  let needsChildProof = false;
  try {
    const cwd = await readLink(join(path, 'cwd'));
    if (cwd !== checkout) throw new Error('Supervisor cwd is foreign');
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') needsChildProof = true;
    else throw error;
  }
  try {
    const exe = await readLink(join(path, 'exe'));
    if (basename(exe) !== 'node') throw new Error('Supervisor exe is foreign');
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') needsChildProof = true;
    else throw error;
  }
  if (needsChildProof && !(await verifyDirectApiChild(procRoot, pid, checkout)))
    throw new Error('Supervisor identity not provable without direct API child');

  const last = parseSupervisorStat(await readFile(join(path, 'stat'), 'utf8'), pid);
  if (last.startTicks !== identity.startTicks || !ACTIVE_STATUSES.has(last.state))
    throw new Error('Supervisor changed during inspection');
  return {
    status: 'exact-operator-supervisor-verified',
    startTicks: identity.startTicks,
    sourceCheckoutCanonical: true,
    processOwnerVerified: true,
    scriptIdentityVerified: true,
    childLinkageVerified: needsChildProof,
    signalsSent: false,
    operatorProcessesStopped: false,
  };
}

/**
 * Caller must inspect first, then explicitly approve exact PID+starttime.
 * Injected signal hook is test-only; production always uses process.kill(pid).
 */
export async function runOwnerShutdown({
  mode,
  checkout,
  pid,
  startTicks = null,
  signalProcess = (targetPid, signal) => process.kill(targetPid, signal),
  scan = inspectOperatorProcesses,
  inspect = inspectSupervisor,
  ports = [3100, 3101],
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const snapshot = await inspect(checkout, pid);
  const safe = {
    checkoutCanonical: snapshot.sourceCheckoutCanonical === true,
    supervisorVerified:
      snapshot.processOwnerVerified === true && snapshot.scriptIdentityVerified === true,
    startTicks: snapshot.startTicks,
    signalsSent: false,
    processesStopped: false,
    gitWritesPerformed: false,
    productionAuditMutated: false,
    servicesRestarted: false,
  };
  if (!safe.checkoutCanonical || !safe.supervisorVerified || !TICKS.test(snapshot.startTicks ?? ''))
    throw new Error('Exact supervisor proof unavailable');
  if (mode === '--inspect-only') return { status: 'read-only-supervisor-verified', ...safe };
  if (
    mode !== '--confirm-graceful-stop' ||
    !TICKS.test(startTicks ?? '') ||
    snapshot.startTicks !== startTicks ||
    !safe.checkoutCanonical ||
    !safe.supervisorVerified ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 200 ||
    timeoutMs > 30_000
  )
    throw new Error('Explicit supervisor identity confirmation failed');

  // Final process birthtime and executable identity check immediately before
  // SIGTERM; never signal a process group or fall back to SIGKILL.
  const last = await inspect(checkout, pid);
  if (
    last.startTicks !== startTicks ||
    !last.scriptIdentityVerified ||
    !last.processOwnerVerified ||
    !last.sourceCheckoutCanonical
  )
    throw new Error('Supervisor changed before signal');
  signalProcess(pid, 'SIGTERM');

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await readCurrentProcess(pid);
    if (current && current.startTicks !== startTicks)
      throw new Error('PID reused before supervisor exit could be confirmed');
    if (!current || !ACTIVE_STATUSES.has(current.state)) {
      const inventory = await scan(checkout);
      if (
        inventory?.status !== 'no-known-operator-processes-at-scan-time' ||
        inventory.totalBlocking !== 0 ||
        !(await portsAvailable(ports))
      ) {
        // Give supervisor-owned API/Web child groups time to terminate.
        // Never send another signal or claim success while they survive.
        await wait(POLL_MS);
        continue;
      }
      return {
        status: 'graceful-operator-stop-verified',
        ...safe,
        signalsSent: true,
        processesStopped: true,
      };
    }
    await wait(POLL_MS);
  }
  throw new Error('Supervisor failed to stop gracefully; manual owner inspection required');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseShutdownArgs(argv);
  const result = await runOwnerShutdown(args);
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(
      'OWNER_OPERATOR_SHUTDOWN_REJECTED: review exact supervisor identity, child state and ports\n',
    );
    process.exitCode = 2;
  });
}
