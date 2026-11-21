/**
 * Read-only Linux /proc examination before a primary source cutover.
 * No signal/process mutation, no environment or credentials read, no PID,
 * command-line, cwd, argv or private path values in the returned summary.
 */
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PID = /^[1-9][0-9]{0,9}$/;
const MAX_PROCESSES = 32768;
const MAX_COMMAND_BYTES = 8192;
const RACE = new Set(['ENOENT', 'ESRCH']);
const NODE_EXECUTABLES =
  /^(?:node(?:js)?|pnpm(?:\.cjs)?|npm(?:\.cmd)?|npx|corepack|bun|tsx|next|yarn)(?:-[0-9.]+)?$/i;
const EXPLICIT_HUB_COMMAND =
  /(?:^|[\\/\s])(?:dev-operator\.mjs|apps[\\/]api[\\/]dist[\\/]main\.js|node_modules[\\/]next[\\/]dist[\\/]bin[\\/]next)(?:$|[\s])/;
const OPERATOR_SHELL_COMMAND =
  /(?:^|\s)(?:pnpm\s+dev:operator|node\s+scripts[\\/]dev-operator\.mjs)(?:$|\s)/;

export function classifyOperatorCandidate(checkout, cwd, argv) {
  const root = resolve(checkout);
  const cwdMatch = cwd === root || cwd === join(root, 'apps/api') || cwd === join(root, 'apps/web');
  if (!cwdMatch) return null;
  if (!Array.isArray(argv) || argv.length < 1) return 'uninspectable-operator-process';
  const executable = argv[0].split('/').at(-1);
  if (NODE_EXECUTABLES.test(executable)) return 'operator-node-toolchain';
  const command = argv.slice(1).join(' ');
  if (EXPLICIT_HUB_COMMAND.test(command) || OPERATOR_SHELL_COMMAND.test(command))
    return 'operator-launch-command';
  return null;
}

/**
 * Intentionally treats unknown *same-owner* Linux process metadata as
 * blocking rather than declaring safe. Ignores only normal /proc PID races.
 * This scan is a momentary safety check, never a quiescence lock.
 */
export async function inspectOperatorProcesses(
  checkout,
  { procRoot = '/proc', uid = process.getuid?.(), selfPid = process.pid } = {},
) {
  if (process.platform !== 'linux' || uid === undefined || uid === 0)
    throw new Error('Non-root Linux operator process inspection required');
  if (resolve(checkout) !== checkout || (await realpath(checkout)) !== checkout)
    throw new Error('Primary checkout must be canonical');
  const paths = await readdir(procRoot, { withFileTypes: true });
  if (paths.length > MAX_PROCESSES) throw new Error('Process table too large to safely inspect');
  const summary = {
    status: 'operator-processes-not-confirmed-stopped',
    nodeToolchain: 0,
    hubLaunchCommand: 0,
    uninspectableSameOwner: 0,
    totalBlocking: 0,
    signalsSent: false,
    processesStopped: false,
    originalCheckoutMutated: false,
  };
  for (const item of paths) {
    if (!PID.test(item.name) || !item.isDirectory() || Number(item.name) === selfPid) continue;
    const entry = join(procRoot, item.name);
    let owner;
    try {
      owner = await lstat(entry);
    } catch (error) {
      if (RACE.has(error.code)) continue;
      throw new Error('Cannot verify process directory ownership');
    }
    if (owner.uid !== uid) continue;
    let cwd;
    try {
      cwd = await readlink(join(entry, 'cwd'));
    } catch (error) {
      if (RACE.has(error.code)) continue;
      // Linux ptrace/Yama may deny cwd for unrelated same-owner desktop
      // processes. Read command-line metadata only to identify a concrete
      // Hub association; do not log or return command line or PID.
      let deniedArgs;
      try {
        const commandBytes = await readFile(join(entry, 'cmdline'));
        if (!commandBytes.length || commandBytes.length > MAX_COMMAND_BYTES) {
          summary.uninspectableSameOwner++;
          continue;
        }
        deniedArgs = commandBytes.toString('utf8').split('\0').filter(Boolean);
      } catch (secondError) {
        if (RACE.has(secondError.code)) continue;
        summary.uninspectableSameOwner++;
        continue;
      }
      const command = deniedArgs.join(' ');
      if (
        command.includes(checkout + '/') ||
        EXPLICIT_HUB_COMMAND.test(command) ||
        OPERATOR_SHELL_COMMAND.test(command) ||
        /next-server/i.test(deniedArgs[0] ?? '')
      )
        summary.uninspectableSameOwner++;
      continue;
    }
    if (
      cwd !== checkout &&
      cwd !== join(checkout, 'apps/api') &&
      cwd !== join(checkout, 'apps/web')
    )
      continue;
    let raw;
    try {
      const file = await readFile(join(entry, 'cmdline'));
      if (file.length > MAX_COMMAND_BYTES || !file.length) {
        summary.uninspectableSameOwner++;
        continue;
      }
      raw = file.toString('utf8').split('\0').filter(Boolean);
    } catch (error) {
      if (RACE.has(error.code)) continue;
      summary.uninspectableSameOwner++;
      continue;
    }
    const found = classifyOperatorCandidate(checkout, cwd, raw);
    if (found === 'operator-node-toolchain') summary.nodeToolchain++;
    else if (found === 'operator-launch-command') summary.hubLaunchCommand++;
    else if (found === 'uninspectable-operator-process') summary.uninspectableSameOwner++;
  }
  summary.totalBlocking =
    summary.nodeToolchain + summary.hubLaunchCommand + summary.uninspectableSameOwner;
  summary.status =
    summary.totalBlocking === 0
      ? 'no-known-operator-processes-at-scan-time'
      : 'operator-processes-not-confirmed-stopped';
  return summary;
}
