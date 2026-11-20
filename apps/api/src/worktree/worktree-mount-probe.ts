import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve, isAbsolute, win32 } from 'node:path';
import { callDocker, dockerEnvironment } from '../boundary/boundary.service.js';
import { workerArguments, validateWorkerImage, WORKER_IMAGE } from '../worker/worker.service.js';

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
  if (
    !isAbsolute(sourcePath) ||
    resolve(sourcePath) !== sourcePath ||
    /[,\r\n\0]/.test(sourcePath) ||
    sourcePath.toLowerCase().includes('docker.sock')
  ) {
    throw new Error('Unsafe bind mount source');
  }
  const args = workerArguments(name, imageId);
  const index = args.indexOf(imageId);
  if (index < 0) throw new Error('Missing image');
  args.splice(index, 0, '--mount', `type=bind,source=${sourcePath},target=/workspace,readonly`);
  return args;
}

const READ_FILE_LIMIT = 8_192;

/** One regular source file, never a command, glob, directory or hidden path. */
export function validateScopedCodePath(path: string): void {
  if (
    path.length < 1 ||
    path.length > 160 ||
    !/^[a-zA-Z0-9._/-]+$/.test(path) ||
    !/\.(ts|tsx|js|jsx|json|md|css|html|yml|yaml)$/.test(path) ||
    path.split('/').some((part) => !part || part.startsWith('.') || part.includes('..'))
  ) {
    throw new Error('Invalid scoped source file path');
  }
}

/** Accept only native Windows paths or documented Docker Desktop drive mappings. */
export function equivalentMountSource(
  actual: string,
  expected: string,
  platform = process.platform,
): boolean {
  if (platform !== 'win32') return actual === expected;
  if (!/^[a-z]:[\\/]/i.test(expected)) return false;
  const normalized = (value: string) => value.replaceAll('\\', '/').toLowerCase();
  const wanted = normalized(win32.normalize(expected));
  let observed: string;
  if (/^[a-z]:[\\/]/i.test(actual)) {
    if (actual.split(/[\\/]/).some((part) => part === '.' || part === '..')) {
      return false;
    }
    observed = normalized(win32.normalize(actual));
  } else {
    const mapped = /^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\/(.+)$/i.exec(actual);
    if (!mapped || mapped[2]!.split('/').some((part) => !part || part === '.' || part === '..')) {
      return false;
    }
    observed = normalized(win32.normalize(mapped[1] + ':/' + mapped[2]));
  }
  return wanted === observed && !actual.includes('~');
}

type ObservedMount = {
  Type?: string;
  Source?: string;
  Target?: string;
  Destination?: string;
  ReadOnly?: boolean;
  RW?: boolean;
};

export function validateObservedMounts(
  raw: string,
  expectedSource: string,
  platform = process.platform,
): void {
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
  if (
    mount.Type !== 'bind' ||
    (mount.Target ?? mount.Destination) !== '/workspace' ||
    (mount.ReadOnly !== true && mount.RW !== false) ||
    mount.ReadOnly === false ||
    mount.RW === true ||
    !mount.Source ||
    !equivalentMountSource(mount.Source, expectedSource, platform)
  ) {
    throw new Error('Bind source, read-only policy or destination mismatch');
  }
}

type Pending = {
  expected: 'ready' | 'pong' | 'stopped' | 'file';
  resolve: (value: string | undefined) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** Ephemeral fixed-protocol worker. Never accepts shell commands. */
export async function runMountedWorkerProbe(
  sourcePath: string,
  readPath?: string,
): Promise<string | undefined> {
  if (readPath !== undefined) validateScopedCodePath(readPath);
  const context = await callDocker(
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    8_000,
  );
  if (
    !(process.platform === 'win32'
      ? context.startsWith('npipe:////./pipe/')
      : context.startsWith('unix://'))
  ) {
    throw new Error('Remote Docker engine rejected');
  }
  if ((await callDocker(['info', '--format', '{{.OSType}}'], 8_000)) !== 'linux') {
    throw new Error('Linux Docker Engine required');
  }
  const imageInfo = await callDocker(
    ['image', 'inspect', WORKER_IMAGE, '--format', '{{.Id}}|{{json .Config}}'],
    8_000,
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
  let cleanupFailed = false;
  let readContent: string | undefined;

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
    running.stdin.on('error', () => fail(new Error('Docker worker stdin unavailable')));
    running.stdout.on('error', () => fail(new Error('Docker worker stdout unavailable')));
    running.stdout.setEncoding('utf8');
    running.stdout.on('data', (part: string) => {
      buffer += part;
      if (buffer.length > 16_384) {
        fail(new Error('Worker response exceeds limit'));
        running.kill();
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        let reply: {
          protocol?: number;
          event?: string;
          executionEnabled?: boolean;
          contentBase64?: string;
        };
        try {
          reply = JSON.parse(line) as typeof reply;
        } catch {
          fail(new Error('Worker response is not JSON'));
          running.kill();
          return;
        }
        const waiter = pending;
        if (
          !waiter ||
          reply.protocol !== 1 ||
          reply.event !== waiter.expected ||
          reply.executionEnabled !== false
        ) {
          fail(new Error('Worker protocol rejected'));
          running.kill();
          return;
        }
        let text: string | undefined;
        if (waiter.expected === 'file') {
          const encoded = reply.contentBase64;
          if (
            encoded === undefined ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
          ) {
            fail(new Error('Invalid worker file encoding'));
            running.kill();
            return;
          }
          const bytes = Buffer.from(encoded, 'base64');
          if (bytes.length > READ_FILE_LIMIT || bytes.toString('base64') !== encoded) {
            fail(new Error('Worker read exceeds limit'));
            running.kill();
            return;
          }
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            fail(new Error('Worker read is not UTF-8'));
            running.kill();
            return;
          }
        }
        pending = null;
        clearTimeout(waiter.timer);
        waiter.resolve(text);
        newline = buffer.indexOf('\n');
      }
    });
    running.on('error', () => fail(new Error('Docker worker transport failure')));
    running.on('exit', () => {
      fail(new Error('Docker worker exited unexpectedly'));
    });
    const exchange = (
      request: string,
      expected: Pending['expected'],
    ): Promise<string | undefined> =>
      new Promise((resolveReady, reject) => {
        if (pending || running.exitCode !== null) {
          reject(new Error('Worker already busy or exited'));
          return;
        }
        const timer = setTimeout(
          () => fail(new Error('Worker protocol timeout')),
          PROTOCOL_TIMEOUT_MS,
        );
        pending = { expected, resolve: resolveReady, reject, timer };
        running.stdin.write(request + '\n', 'utf8', (error) => {
          if (error) fail(new Error('Worker stdin transport failure'));
        });
      });

    await exchange('HELLO/1', 'ready');
    const mounts = await callDocker(
      ['inspect', '--format', '{{json .HostConfig.Mounts}}', name],
      8_000,
    );
    validateObservedMounts(mounts, sourcePath);
    const observed = await callDocker(['inspect', '--format', '{{json .Mounts}}', name], 8_000);
    validateObservedMounts(observed, sourcePath);
    const isolation = await callDocker(
      [
        'inspect',
        '--format',
        '{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.Config.User}}|{{.HostConfig.Privileged}}|{{.HostConfig.AutoRemove}}|{{.HostConfig.IpcMode}}',
        name,
      ],
      8_000,
    );
    // Kernel-policy fields checked via Docker inspect, never asserted from intent alone.
    const segments = isolation.split('|');
    if (
      segments.length !== 6 ||
      segments[0] !== 'none' ||
      segments[1] !== 'true' ||
      segments[2] !== '65534:65534' ||
      segments[3] !== 'false' ||
      segments[4] !== 'true' ||
      segments[5] !== 'none'
    ) {
      throw new Error('Unsafe Docker container configuration');
    }
    const constraints = await callDocker(
      [
        'inspect',
        '--format',
        '{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}',
        name,
      ],
      8_000,
    );
    const flags = constraints.split('|');
    const capabilities = JSON.parse(flags[0] ?? 'null') as unknown;
    const security = JSON.parse(flags[1] ?? 'null') as unknown;
    if (
      flags.length !== 5 ||
      !Array.isArray(capabilities) ||
      capabilities.length !== 1 ||
      String(capabilities[0]).toUpperCase() !== 'ALL' ||
      !Array.isArray(security) ||
      !security.some((entry) => String(entry).startsWith('no-new-privileges')) ||
      flags[2] !== '32' ||
      flags[3] !== '134217728' ||
      flags[4] !== '500000000'
    ) {
      throw new Error('Docker capability or resource boundaries changed');
    }
    await exchange('PING/1', 'pong');
    if (readPath) readContent = await exchange(`READ/1 ${readPath}`, 'file');
    await exchange('SHUTDOWN/1', 'stopped');
    running.stdin.end();
  } finally {
    fail(new Error('Probe interrupted'));
    child?.stdin.end();
    child?.kill();
    // Explicit daemon-side cleanup, even if the CLI process has exited.
    try {
      await callDocker(['rm', '--force', name], 8_000);
    } catch {
      // --rm might have removed it already. Fail closed if state is uncertain.
      try {
        const remaining = await callDocker(
          ['ps', '--all', '--quiet', '--filter', `name=^${name}$`],
          8_000,
        );
        cleanupFailed = Boolean(remaining);
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) {
    throw new Error('Unable to confirm Docker probe container cleanup');
  }
  return readContent;
}
