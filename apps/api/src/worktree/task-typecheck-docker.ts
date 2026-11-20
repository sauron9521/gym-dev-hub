/**
 * Local fixed API_TYPECHECK Docker adapter. No caller-controlled image, mounts,
 * command or environment. Fail-closed without preprovisioned pinned artifacts.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { callDocker, dockerEnvironment } from '../boundary/boundary.service.js';
import { equivalentMountSource } from './worktree-mount-probe.js';

const IMAGE = 'gym-dev-hub-node-runner:v1';
const SOURCE_COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const SOURCE_TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const MANIFEST_SHA = 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';
const RECIPE = '/opt/gym-dev-hub/api-typecheck-local.mjs';
const OUTPUT_LIMIT = 65536;
const RUN_TIMEOUT = 600_000;
const ENV_DIRS = [
  ['DEV_HUB_TASK_SOURCE_SNAPSHOT', '/source'],
  ['DEV_HUB_TASK_SOURCE_MANIFEST', '/manifest'],
  ['DEV_HUB_TASK_PNPM_STORE', '/store'],
  ['DEV_HUB_TASK_PRISMA_ENGINE', '/engine'],
] as const;

type Mount = { Type?: string; Source?: string; Destination?: string; RW?: boolean };
type DockerReply = {
  protocol?: number;
  event?: string;
  recipe?: string;
  sourceCommit?: string;
  sourceTree?: string;
  sourceManifestSha256?: string;
  typescriptVersion?: string;
  prismaGenerated?: boolean;
  apiTypecheckExecuted?: boolean;
  typecheckExitCode?: number;
  sourceReadOnly?: boolean;
  networkEnabled?: boolean;
  operatorGrantConsumedInsideContainer?: boolean;
  hostGrantVerificationInsideContainer?: boolean;
  delegatedAuthorization?: string;
  arbitraryCommandsEnabled?: boolean;
  dependencyLifecycleScriptsExecuted?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
};
export interface PreparedTypecheckRunner {
  imageId: string;
  mounts: readonly { source: string; target: string }[];
}

function strictJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Malformed Docker isolation or runner receipt');
  }
}

async function strictDirectory(path: string): Promise<string> {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    /[,\r\n\0]/.test(path) ||
    path.toLowerCase().includes('docker.sock')
  )
    throw new Error('Unsafe local task dependency path');
  let current = path;
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Symlink/junction or non-directory in task dependency path');
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return realpath(path);
}

export function validateRunnerReceipt(raw: string): { stdoutBytes: number; stderrBytes: number } {
  const reply = strictJson(raw) as DockerReply;
  if (
    reply.protocol !== 1 ||
    reply.event !== 'pinned-api-typecheck-local-executed' ||
    reply.recipe !== 'API_TYPECHECK' ||
    reply.sourceCommit !== SOURCE_COMMIT ||
    reply.sourceTree !== SOURCE_TREE ||
    reply.sourceManifestSha256 !== MANIFEST_SHA ||
    reply.typescriptVersion !== '6.0.3' ||
    reply.prismaGenerated !== true ||
    reply.apiTypecheckExecuted !== true ||
    reply.typecheckExitCode !== 0 ||
    reply.sourceReadOnly !== true ||
    reply.networkEnabled !== false ||
    reply.dependencyLifecycleScriptsExecuted !== false ||
    reply.operatorGrantConsumedInsideContainer !== false ||
    reply.hostGrantVerificationInsideContainer !== false ||
    reply.delegatedAuthorization !== 'host-service-only' ||
    reply.arbitraryCommandsEnabled !== false ||
    !Number.isSafeInteger(reply.stdoutBytes) ||
    !Number.isSafeInteger(reply.stderrBytes) ||
    reply.stdoutBytes! > OUTPUT_LIMIT ||
    reply.stderrBytes! > OUTPUT_LIMIT ||
    reply.stdoutBytes! < 0 ||
    reply.stderrBytes! < 0
  )
    throw new Error('Unverified runner source, recipe or isolation receipt');
  return { stdoutBytes: reply.stdoutBytes!, stderrBytes: reply.stderrBytes! };
}

export function validateRunnerMounts(
  raw: string,
  expected: PreparedTypecheckRunner['mounts'],
): void {
  const observed = strictJson(raw);
  if (!Array.isArray(observed) || observed.length !== expected.length) {
    throw new Error('Unexpected Docker bind mount count');
  }
  const mounts = observed as Mount[];
  for (const target of expected) {
    const matched = mounts.filter((entry) => entry.Destination === target.target);
    if (
      matched.length !== 1 ||
      matched[0]?.Type !== 'bind' ||
      matched[0]?.RW !== false ||
      !matched[0]?.Source ||
      !equivalentMountSource(matched[0].Source, target.source)
    )
      throw new Error('Unexpected Docker bind source, target or write permission');
  }
}

export function validateRunnerIsolation(raw: string): void {
  const [network, readOnly, uid, privileged, ipc, pids, memory, nanoCpus] = raw.split('|');
  if (
    raw.split('|').length !== 8 ||
    network !== 'none' ||
    readOnly !== 'true' ||
    uid !== '65534:65534' ||
    privileged !== 'false' ||
    ipc !== 'none' ||
    pids !== '128' ||
    memory !== '5368709120' ||
    nanoCpus !== '2000000000'
  )
    throw new Error('Unapproved Docker isolation or resource limits');
}

export function validateRunnerSecurity(raw: string): void {
  const [capsRaw, optsRaw, tmpfsRaw] = raw.split('|');
  if (raw.split('|').length !== 3) throw new Error('Incomplete Docker security inspection');
  const caps = strictJson(capsRaw!);
  const security = strictJson(optsRaw!);
  const tmpfs = strictJson(tmpfsRaw!);
  if (
    !Array.isArray(caps) ||
    caps.length !== 1 ||
    String(caps[0]).toUpperCase() !== 'ALL' ||
    !Array.isArray(security) ||
    !security.some((item) => String(item).startsWith('no-new-privileges')) ||
    !tmpfs ||
    typeof tmpfs !== 'object' ||
    Array.isArray(tmpfs)
  )
    throw new Error('Unapproved Docker capabilities or scratch volume');
  const entries = tmpfs as Record<string, string>;
  if (
    Object.keys(entries).sort().join(',') !== '/results,/tmp,/workspace' ||
    Object.values(entries).some(
      (value) => !['noexec', 'nosuid', 'nodev'].every((x) => value.includes(x)),
    )
  )
    throw new Error('Executable or unexpected Docker scratch mount');
}

export async function prepareTypecheckRunner(): Promise<PreparedTypecheckRunner> {
  const configuredId = process.env.DEV_HUB_TASK_RUNNER_IMAGE_ID;
  if (!configuredId || !/^sha256:[a-f0-9]{64}$/.test(configuredId)) {
    throw new Error('Task runner image SHA-256 must be pinned explicitly');
  }
  const mounts = [];
  for (const [key, target] of ENV_DIRS) {
    const value = process.env[key];
    if (!value) throw new Error('Missing preprovisioned pinned task dependency');
    mounts.push({ source: await strictDirectory(value), target });
  }
  if (new Set(mounts.map((m) => m.source.toLowerCase())).size !== mounts.length) {
    throw new Error('Overlapping task dependency mount root');
  }
  const endpoint = await callDocker(
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    8000,
  );
  if (
    !(process.platform === 'win32'
      ? endpoint.startsWith('npipe:////./pipe/')
      : endpoint.startsWith('unix://')) ||
    (await callDocker(['info', '--format', '{{.OSType}}'], 8000)) !== 'linux'
  )
    throw new Error('Local Linux Docker Engine required');
  const details = await callDocker(
    [
      'image',
      'inspect',
      IMAGE,
      '--format',
      '{{.Id}}|{{.Config.User}}|{{.Os}}|{{.Architecture}}|{{index .Config.Labels "org.gym-dev-hub.runner.execution"}}|{{json .Config.Entrypoint}}',
    ],
    8000,
  );
  const [actualId, user, os, architecture, execution, entrypoint] = details.split('|');
  if (
    details.split('|').length !== 6 ||
    actualId !== configuredId ||
    user !== '65534:65534' ||
    os !== 'linux' ||
    architecture !== 'amd64' ||
    execution !== 'disabled' ||
    entrypoint !== '["/usr/bin/node","/opt/gym-dev-hub/runner.mjs"]'
  )
    throw new Error('Docker image differs from operator-pinned runner');
  return { imageId: actualId!, mounts };
}

function runAttached(name: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolveResult, reject) => {
    if (signal.aborted) return reject(new Error('Task canceled before container start'));
    const child = spawn('docker', ['start', '--attach', name], {
      shell: false,
      windowsHide: true,
      env: dockerEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrBytes = 0;
    let failed = false;
    let complete = false;
    const stop = () => {
      failed = true;
      child.kill();
    };
    const timeout = setTimeout(stop, RUN_TIMEOUT);
    const abort = () => stop();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > OUTPUT_LIMIT) stop();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > OUTPUT_LIMIT) stop();
    });
    const finish = (error?: Error) => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolveResult(stdout.trim());
    };
    child.on('error', () => finish(new Error('Docker task transport failed')));
    child.on('close', (code) =>
      finish(
        failed || signal.aborted || code !== 0
          ? new Error('Fixed API_TYPECHECK failed, canceled or exceeded limits')
          : undefined,
      ),
    );
  });
}

export async function runPinnedTypecheckDocker(
  prepared: PreparedTypecheckRunner,
  signal: AbortSignal,
): Promise<{ stdoutBytes: number; stderrBytes: number; containerRemoved: true }> {
  const name = 'gym-dev-hub-api-typecheck-' + randomUUID();
  let outcome: { stdoutBytes: number; stderrBytes: number } | undefined;
  let cleanupError = false;
  let runError: unknown;
  try {
    if (signal.aborted) throw new Error('Task canceled');
    const args = [
      'create',
      '--name',
      name,
      '--pull=never',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--user=65534:65534',
      '--ipc=none',
      '--pids-limit=128',
      '--memory=5g',
      '--cpus=2',
      '--tmpfs=/workspace:rw,nosuid,nodev,noexec,size=3072m,mode=1777',
      '--tmpfs=/results:rw,nosuid,nodev,noexec,size=32m,mode=1777',
      '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
      ...prepared.mounts.flatMap(({ source, target }) => [
        '--mount',
        'type=bind,source=' + source + ',target=' + target + ',readonly',
      ]),
      '--stop-timeout=3',
      '--entrypoint=/usr/bin/node',
      prepared.imageId,
      RECIPE,
    ];
    await callDocker(args, 25000);
    validateRunnerIsolation(
      await callDocker(
        [
          'inspect',
          '--format',
          '{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.Config.User}}|{{.HostConfig.Privileged}}|{{.HostConfig.IpcMode}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}',
          name,
        ],
        8000,
      ),
    );
    validateRunnerSecurity(
      await callDocker(
        [
          'inspect',
          '--format',
          '{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{json .HostConfig.Tmpfs}}',
          name,
        ],
        8000,
      ),
    );
    validateRunnerMounts(
      await callDocker(['inspect', '--format', '{{json .Mounts}}', name], 8000),
      prepared.mounts,
    );
    const observedImage = await callDocker(['inspect', '--format', '{{.Image}}', name], 8000);
    if (observedImage !== prepared.imageId) throw new Error('Docker image ID substituted');
    if (signal.aborted) throw new Error('Task canceled');
    outcome = validateRunnerReceipt(await runAttached(name, signal));
    const exitCode = await callDocker(['inspect', '--format', '{{.State.ExitCode}}', name], 8000);
    if (exitCode !== '0') throw new Error('Pinned API_TYPECHECK exited unsuccessfully');
  } catch (error) {
    runError = error;
  } finally {
    try {
      await callDocker(['rm', '--force', name], 10000);
    } catch {
      const remaining = await callDocker(
        ['ps', '--all', '--quiet', '--filter', 'name=^' + name + '$'],
        8000,
      ).catch(() => '__unknown__');
      cleanupError = Boolean(remaining);
    }
  }
  if (cleanupError) throw new Error('Cannot prove Docker task container cleanup');
  if (runError) throw runError;
  if (!outcome) throw new Error('No verified typecheck receipt');
  return { ...outcome, containerRemoved: true };
}
