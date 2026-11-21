/** Local operator mode: Web HMR with a prebuilt, watch-free API. */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POLICY = Object.freeze({ pnpm: '12.18.0', apiPort: 3101, webPort: 3100 });
function port(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9]\d{3,4}$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
    throw new Error(`${name} must be a port from 1024 to 65535`);
  }
  return Number(value);
}
export function operatorPorts(env) {
  const apiPort = port(env.DEV_HUB_OPERATOR_API_PORT, POLICY.apiPort, 'DEV_HUB_OPERATOR_API_PORT');
  const webPort = port(env.DEV_HUB_OPERATOR_WEB_PORT, POLICY.webPort, 'DEV_HUB_OPERATOR_WEB_PORT');
  if (apiPort === webPort) throw new Error('API and Web must not share a port');
  return { apiPort, webPort };
}
export function operatorCommands(root, ports, env) {
  return {
    builds: [
      ['--filter', '@gym-dev-hub/contracts', 'build'],
      ['--filter', '@gym-dev-hub/api', 'build'],
    ],
    api: {
      executable: process.execPath,
      args: [join(root, 'apps/api/dist/main.js')],
      cwd: join(root, 'apps/api'),
      env: { ...env, PORT: String(ports.apiPort) },
    },
    web: {
      // Run Next directly to keep the API/Web process-group lifecycle
      // under this supervisor; pnpm exec can spawn an extra process group.
      executable: process.execPath,
      args: [
        join(root, 'apps/web/node_modules/next/dist/bin/next'),
        'dev',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(ports.webPort),
      ],
      cwd: join(root, 'apps/web'),
      env: { ...env, DEV_HUB_API_URL: `http://127.0.0.1:${ports.apiPort}` },
    },
  };
}
function requireHost() {
  if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Local operator mode supports Linux and Node 24+');
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Do not run operator mode as root');
  }
  const version = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (version.status !== 0 || version.stdout.trim() !== POLICY.pnpm) {
    throw new Error(`Expected pinned pnpm ${POLICY.pnpm}`);
  }
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (docker.status !== 0 || !docker.stdout.trim()) {
    throw new Error("Docker socket not accessible. Run: sg docker -c 'pnpm dev:operator'");
  }
}
async function checkAvailablePort(number) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(number, '127.0.0.1', resolve);
    });
  } catch (error) {
    throw new Error(
      `Operator localhost port ${number} unavailable (${error.code || 'bind error'}); do not stop unrelated services`,
    );
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
function build(builds) {
  for (const args of builds) {
    const result = spawnSync('pnpm', args, { cwd: ROOT, stdio: 'inherit', timeout: 180_000 });
    if (result.status !== 0 || result.error) {
      throw new Error(`Pinned build failed (${result.error?.code ?? result.status})`);
    }
  }
}
function runServices(config, ports) {
  const children = [];
  let shuttingDown = false;
  let exitCode = 0;
  function terminate(signal = 'SIGTERM') {
    for (const child of children) {
      if (!child.pid) continue;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') console.error('Process shutdown failed', error.code);
      }
    }
  }
  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = code;
    // A failed spawn may never emit an exit event; the supervisor must fail closed.
    process.exitCode = code;
    terminate();
    const force = setTimeout(() => terminate('SIGKILL'), 4_000);
    force.unref();
    if (children.every((c) => c.exitCode !== null || c.signalCode !== null))
      process.exitCode = exitCode;
  }
  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));
  process.on('exit', () => terminate());
  for (const [name, cmd] of Object.entries({ api: config.api, web: config.web })) {
    const child = spawn(cmd.executable, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env,
      stdio: 'inherit',
      detached: true,
    });
    children.push(child);
    child.once('error', (error) => {
      console.error('OPERATOR_CHILD_FAILED', name, error.code || 'spawn');
      shutdown(1);
    });
    child.once('exit', (code, signal) => {
      console.log('OPERATOR_CHILD_EXIT', JSON.stringify({ name, code, signal }));
      if (!shuttingDown) shutdown(code === 0 ? 1 : (code ?? (signal ? 130 : 1)));
      if (children.every((c) => c.exitCode !== null || c.signalCode !== null))
        process.exitCode = exitCode;
    });
  }
  console.log(
    'OPERATOR_SERVICES_STARTED',
    JSON.stringify({
      api: `http://127.0.0.1:${ports.apiPort}`,
      web: `http://127.0.0.1:${ports.webPort}`,
      apiWatch: false,
      webHmr: true,
    }),
  );
}
export async function main() {
  if (process.argv.length !== 2)
    throw new Error(
      'Usage: pnpm dev:operator (optional DEV_HUB_OPERATOR_API_PORT / DEV_HUB_OPERATOR_WEB_PORT)',
    );
  const ports = operatorPorts(process.env);
  requireHost();
  await checkAvailablePort(ports.apiPort);
  await checkAvailablePort(ports.webPort);
  console.log('OPERATOR_PREFLIGHT_PASSED', JSON.stringify({ ports, dockerSocket: 'accessible' }));
  const config = operatorCommands(ROOT, ports, process.env);
  build(config.builds);
  await checkAvailablePort(ports.apiPort);
  await checkAvailablePort(ports.webPort);
  runServices(config, ports);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('OPERATOR_START_REJECTED', error.message);
    process.exitCode = 1;
  });
}
