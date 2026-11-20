import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { callDocker, dockerEnvironment } from '../boundary/boundary.service.js';
import {
  workerArguments,
  validateWorkerImage,
  WORKER_IMAGE,
} from '../worker/worker.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROTOCOL_TIMEOUT_MS = 12_000;

/**
 * Insert exactly one read-only host bind. Keep the reviewed non-root,
 * no-network, no-capabilities worker args and immutable image ID unchanged.
 * No user-provided CLI flags or command text are accepted.
 */
export function mountedWorkerArguments(
  name: string,
  imageId: string,
  sourcePath: string,
): string[] {
  if (!isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath ||
      /[,\r\n\0]/.test(sourcePath) ||
      sourcePath.includes('docker.sock')) {
    throw new Error('Unsafe bind mount source');
  }
  const args = workerArguments(name, imageId);
  const index = args.indexOf(imageId);
  if (index < 0) throw new Error('Missing image');
  args.splice(index, 0, '--mount',
    `type=bind,source=${sourcePath},target=/workspace,readonly`);
  return args;
}

type ObservedMount = {
  Type?: string;
  Source?: string;
  Target?: string;
  ReadOnly?: boolean;
};

export function validateObservedMounts(raw: string, expectedSource: string): void {
  let mounts: ObservedMount[];
  try {
    mounts = JSON.parse(raw) as ObservedMount[];
  } catch {
    throw new Error('Malformed Docker mount inspection');
  }
  if (!Array.isArray(mounts) || mounts.length !== 1) {
    throw new Error('Unexpected host mounts');
  }
  const mount = mounts[0]!;
  if (mount.Type !== 'bind' || mount.Target !== '/workspace' ||
      mount.ReadOnly !== true ||
      !mount.Source ||
      resolve(mount.Source).toLowerCase() !== resolve(expectedSource).toLowerCase()) {
    throw new Error('Bind source, read-only policy or destination mismatch');
  }
}

function validateHostConfig(raw: string): void {
  const fields = raw.split('|');
  if (fields.length !== 6 ||
      fields[0] !== 'none' || fields[1] !== 'true' ||
      fields[2] !== '65534:65534' || fields[3] !== 'false' ||
      fields[4] !== 'false' || fields[5] !== 'rprivate') {
    throw new Error('Docker isolation settings changed');
  }
}

type Pending = {
  expected: 'ready' | 'pong' | 'stopped';
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** Ephemeral no-command worker. Always attempt to remove container. */
export async function runMountedWorkerProbe(sourcePath: string): Promise<void> {
  const context = await callDocker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], 8_000);
  if (!(process.platform === 'win32'
    ? context.startsWith('npipe:////./pipe/')
    : context.startsWith('unix://'))) {
    throw new Error('Remote Docker engine rejected');
  }
  if ((await callDocker(['info', '--format', '{{.OSType}}'], 8_000)) !== 'linux') {
    throw new Error('Linux Docker Engine required');
  }
  const imageInfo = await callDocker(
    ['image', 'inspect', WORKER_IMAGE, '--format', '{{.Id}}|{{json .Config}}'], 8_000,
  );
  const imageId = validateWorkerImage(imageInfo);
  const name = `gym-dev-hub-worker-${randomUUID()}`;
  if (!UUID.test(name.slice('gym-dev-hub-worker-'.length))) {
    throw new Error('Invalid temporary worker name');
  }
  const args = mountedWorkerArguments(name, imageId, sourcePath);
  let child: ChildProcessWithoutNullStreams | null = null;
  let buffer = '';
  let pending: Pending | null = null;
  let cleanExit = false;

  const fail = (error: Error) => {
    if (!pending) return;
    const waiter = pending;
    pending = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  };

  try {
    const running = spawn('docker', args, {
      env: dockerEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = running;
    running.stderr.resume(); // Docker stderr may expose private host paths.
    running.stdout.setEncoding('utf8');
    running.stdout.on('data', (part: string) => {
      buffer += part;
      if (buffer.length > 4096) {
        fail(new Error('Worker response exceeds limit'));
        running.kill();
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        let reply: { protocol?: number; event?: string; executionEnabled?: boolean };
        try {
          reply = JSON.parse(line) as typeof reply;
        } catch {
          fail(new Error('Worker response is not JSON'));
          running.kill();
          return;
        }
        const waiter = pending;
        if (!waiter || reply.protocol !== 1 ||
            reply.event !== waiter.expected || reply.executionEnabled !== false) {
          fail(new Error('Worker protocol rejected'));
          running.kill();
          return;
        }
        pending = null;
        clearTimeout(waiter.timer);
        waiter.resolve();
        newline = buffer.indexOf('\n');
      }
    });
    running.on('error', () => fail(new Error('Docker worker transport failure')));
    running.on('exit', (code) => {
      cleanExit = code === 0;
      fail(new Error('Docker worker exited unexpectedly'));
    });
    const exchange = (request: 'HELLO/1' | 'PING/1' | 'SHUTDOWN/1',
      expected: Pending['expected']): Promise<void> => new Promise((resolveReady, reject) => {
      if (pending || running.exitCode !== null) {
        reject(new Error('Worker already busy or exited'));
        return;
      }
      const timer = setTimeout(() => fail(new Error('Worker protocol timeout')), PROTOCOL_TIMEOUT_MS);
      pending = { expected, resolve: resolveReady, reject, timer };
      running.stdin.write(request + '\n', 'utf8', (error) => {
        if (error) fail(new Error('Worker stdin transport failure'));
      });
    });

    await exchange('HELLO/1', 'ready');
    const mounts = await callDocker(
      ['inspect', '--format', '{{json .HostConfig.Mounts}}', name], 8_000,
    );
    validateObservedMounts(mounts, sourcePath);
    const isolation = await callDocker(
      ['inspect', '--format',
        '{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.Config.User}}|{{.HostConfig.Privileged}}|{{.HostConfig.AutoRemove}}|{{.HostConfig.IpcMode}}',
        name], 8_000,
    );
    // Kernel-policy fields checked via Docker inspect, never asserted from intent alone.
    const segments = isolation.split('|');
    if (segments.length !== 6 || segments[0] !== 'none' ||
        segments[1] !== 'true' || segments[2] !== '65534:65534' ||
        segments[3] !== 'false' || segments[4] !== 'true' ||
        segments[5] !== 'none') {
      throw new Error('Unsafe Docker container configuration');
    }
    await exchange('PING/1', 'pong');
    await exchange('SHUTDOWN/1', 'stopped');
    running.stdin.end();
  } finally {
    fail(new Error('Probe interrupted'));
    child?.stdin.end();
    child?.kill();
    // A killed CLI is not proof its daemon-side container was removed.
    // Explicit cleanup is mandatory. A cleanup failure propagates to the caller.
    try {
      await callDocker(['rm', '--force', name], 8_000);
    } catch {
      // --rm may already have removed the container after clean shutdown.
      const remaining = await callDocker(
        ['ps', '--all', '--quiet', '--filter', `name=^${name}$`], 8_000,
      );
      if (remaining) throw new Error('Unable to clean up Docker probe container');
    }
  }
}
