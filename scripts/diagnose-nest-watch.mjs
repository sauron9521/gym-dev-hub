/** Explicit, non-default NestJS watch diagnostics. Never used by the API runtime. */
import { spawn } from 'node:child_process';
import { open, mkdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Opt-in NestJS watch diagnostics require Linux and Node >=24');
}
const portArg = process.argv.slice(2);
if (portArg.length > 1 || (portArg.length === 1 && !/^\d{4,5}$/.test(portArg[0]))) {
  throw new Error('Usage: pnpm diagnose:nest-watch [port] (default 3102)');
}
const port = portArg.length ? Number(portArg[0]) : 3102;
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3101) {
  throw new Error('Diagnostic port must be 1024–65535 and different from primary API 3101');
}
const diagnostics = join(ROOT, 'apps/api/.local/nest-watch-diagnostics');
await mkdir(diagnostics, { recursive: true, mode: 0o700 });
const resolved = await realpath(diagnostics);
if (resolved !== diagnostics || !(await stat(diagnostics)).isDirectory()) {
  throw new Error('Diagnostic destination must not be a symlink');
}
const logFile = join(diagnostics, `watch-${Date.now()}-${process.pid}.jsonl`);
const handle = await open(logFile, 'wx', 0o600);
await handle.close();
const probe = join(ROOT, 'scripts/nest-watch-fs-probe.cjs');
const env = {
  ...process.env,
  PORT: String(port),
  DEV_HUB_WATCH_DIAGNOSTIC_ROOT: ROOT,
  DEV_HUB_WATCH_DIAGNOSTIC_LOG: logFile,
  // No tools/commands from the request, only a fixed, repository-owned preload.
  NODE_OPTIONS: [process.env.NODE_OPTIONS ?? '', `--require=${probe}`].filter(Boolean).join(' '),
};
const nestCli = join(ROOT, 'apps/api/node_modules/@nestjs/cli/bin/nest.js');
console.log('WATCH_DIAGNOSTIC_STARTED', JSON.stringify({ port, logFile, maxBytes: 262144 }));
console.log('Only changed paths and watcher process IDs are captured; no file content or secrets.');
const child = spawn(process.execPath, [nestCli, 'start', '--watch', '--preserveWatchOutput'], {
  cwd: join(ROOT, 'apps/api'),
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.once('error', (error) => {
  console.error('WATCH_DIAGNOSTIC_FAILED', error.code || 'spawn-failed');
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  console.log('WATCH_DIAGNOSTIC_FINISHED', JSON.stringify({ code, signal, logFile }));
  process.exitCode = code ?? (signal ? 130 : 1);
});
