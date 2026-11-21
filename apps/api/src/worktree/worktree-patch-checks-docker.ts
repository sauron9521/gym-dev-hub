/**
 * Fixed, opt-in post-apply API/Web check adapter. Project files may execute
 * only inside a strictly isolated Docker container, never on the host.
 * No caller-supplied command, image, flags, env or volumes are supported.
 */
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { callDocker, dockerEnvironment } from '../boundary/boundary.service.js';
import { validateRunnerIsolation, validateRunnerMounts } from './task-typecheck-docker.js';

const IMAGE = 'gym-dev-hub-node-runner:v1';
const ENTRY = '/opt/gym-dev-hub/patch-checks-local.mjs';
const MAX_OUTPUT = 65_536;
const RECIPES = new Set([
  'API_FORMAT',
  'API_TYPECHECK',
  'API_TEST',
  'WEB_FORMAT',
  'WEB_TYPECHECK',
  'WEB_TEST',
]);
const SHA = /^[a-f0-9]{64}$/;
const RUN_TIMEOUT = 570_000;

export type FixedPatchRecipe =
  'API_FORMAT' | 'API_TYPECHECK' | 'API_TEST' | 'WEB_FORMAT' | 'WEB_TYPECHECK' | 'WEB_TEST';
export interface PreparedPatchChecks {
  imageId: string;
  mounts: readonly { source: string; target: string }[];
}
export interface PatchCheckReceipt {
  stdoutBytes: number;
  stderrBytes: number;
  stageFiles: number;
  stageBytes: number;
  containerRemoved: true;
}

async function canonicalDirectory(path: string): Promise<string> {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    /[,\r\n\0]/.test(path) ||
    path.toLowerCase().includes('docker.sock')
  ) {
    throw new Error('Unsafe patch check source path');
  }
  let current = path;
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Patch check path contains symlink or non-directory');
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error('Noncanonical patch check path');
  return canonical;
}

/**
 * Tests can load a reviewed native worker binary (e.g. esbuild), so the
 * disposable /workspace is executable. Source remains an immutable read-only
 * bind; /results and /tmp are noexec. Never reuse the stricter typecheck
 * validator, which requires noexec workspace and cannot run native tests.
 */
export function validatePatchCheckSecurity(raw: string): void {
  const [capsRaw, optsRaw, tmpfsRaw] = raw.split('|');
  if (raw.split('|').length !== 3) throw new Error('Incomplete Docker check security');
  let caps: unknown, opts: unknown, tmpfs: unknown;
  try {
    caps = JSON.parse(capsRaw!);
    opts = JSON.parse(optsRaw!);
    tmpfs = JSON.parse(tmpfsRaw!);
  } catch {
    throw new Error('Malformed Docker check security');
  }
  if (
    !Array.isArray(caps) ||
    caps.length !== 1 ||
    String(caps[0]).toUpperCase() !== 'ALL' ||
    !Array.isArray(opts) ||
    !opts.some((opt) => String(opt).startsWith('no-new-privileges')) ||
    !tmpfs ||
    typeof tmpfs !== 'object' ||
    Array.isArray(tmpfs)
  ) {
    throw new Error('Unexpected Docker security configuration');
  }
  const entries = tmpfs as Record<string, string>;
  if (
    Object.keys(entries).sort().join(',') !== '/results,/tmp,/workspace' ||
    Object.entries(entries).some(
      ([key, value]) =>
        typeof value !== 'string' ||
        !['nosuid', 'nodev'].every((flag) => value.includes(flag)) ||
        (key !== '/workspace' && !value.includes('noexec')) ||
        (key === '/workspace' && (!value.split(',').includes('exec') || value.includes('noexec'))),
    )
  ) {
    throw new Error('Unapproved Docker patch check scratch volumes');
  }
}

export async function preparePatchCheckRunner(worktree: string): Promise<PreparedPatchChecks> {
  const imageId = process.env.DEV_HUB_PATCH_CHECK_IMAGE_ID;
  const store = process.env.DEV_HUB_PATCH_CHECK_PNPM_STORE;
  if (!imageId || !/^sha256:[a-f0-9]{64}$/.test(imageId) || !store) {
    throw new Error('Explicit pinned patch check image ID and offline pnpm store required');
  }
  const mounts = [
    { source: await canonicalDirectory(worktree), target: '/source' },
    { source: await canonicalDirectory(store), target: '/store' },
  ];
  if (
    mounts[0]!.source === mounts[1]!.source ||
    mounts[0]!.source.startsWith(mounts[1]!.source + '/') ||
    mounts[1]!.source.startsWith(mounts[0]!.source + '/')
  ) {
    throw new Error('Unsafe overlapping patch checks mounts');
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
  ) {
    throw new Error('Local Linux Docker Engine required');
  }
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
  const [actual, uid, os, arch, disabled, entrypoint] = details.split('|');
  if (
    details.split('|').length !== 6 ||
    actual !== imageId ||
    uid !== '65534:65534' ||
    os !== 'linux' ||
    arch !== 'amd64' ||
    disabled !== 'disabled' ||
    entrypoint !== '["/usr/bin/node","/opt/gym-dev-hub/runner.mjs"]'
  ) {
    throw new Error('Unexpected patch check runner image');
  }
  return { imageId, mounts };
}

export function validatePatchCheckReceipt(
  raw: string,
  recipeId: FixedPatchRecipe,
  filePath: string,
  proposedSha256: string,
): Omit<PatchCheckReceipt, 'containerRemoved'> {
  let object: unknown;
  try {
    object = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Invalid patch check receipt');
  }
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw new Error('Invalid patch check receipt');
  }
  const r = object as Record<string, unknown>;
  const expectType = recipeId.endsWith('_TEST');
  const expectTypecheck = recipeId.endsWith('_TYPECHECK');
  if (
    r.protocol !== 1 ||
    r.event !== 'one-file-post-apply-check-executed' ||
    r.recipeId !== recipeId ||
    r.filePathSha256 !== createHash('sha256').update(filePath).digest('hex') ||
    r.proposedSha256 !== proposedSha256 ||
    r.testsExecuted !== expectType ||
    r.typecheckExecuted !== expectTypecheck ||
    r.exitCode !== 0 ||
    r.sourceReadOnly !== true ||
    r.networkEnabled !== false ||
    r.lifecycleScriptsExecuted !== false ||
    r.arbitraryCommandsEnabled !== false ||
    !Number.isSafeInteger(r.stageFiles) ||
    (r.stageFiles as number) < 1 ||
    (r.stageFiles as number) > 5_000 ||
    !Number.isSafeInteger(r.stageBytes) ||
    (r.stageBytes as number) < 1 ||
    (r.stageBytes as number) > 100 * 1024 * 1024 ||
    !Number.isSafeInteger(r.stdoutBytes) ||
    (r.stdoutBytes as number) < 0 ||
    (r.stdoutBytes as number) > MAX_OUTPUT ||
    !Number.isSafeInteger(r.stderrBytes) ||
    (r.stderrBytes as number) < 0 ||
    (r.stderrBytes as number) > MAX_OUTPUT
  ) {
    throw new Error('Patch check receipt does not match approved recipe/isolation');
  }
  return {
    stdoutBytes: r.stdoutBytes as number,
    stderrBytes: r.stderrBytes as number,
    stageFiles: r.stageFiles as number,
    stageBytes: r.stageBytes as number,
  };
}

function attached(name: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolveResult, reject) => {
    if (signal.aborted) return reject(new Error('Patch check canceled'));
    const child = spawn('docker', ['start', '--attach', name], {
      shell: false,
      windowsHide: true,
      env: dockerEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrBytes = 0;
    let stopped = false;
    let done = false;
    const fail = () => {
      stopped = true;
      child.kill();
    };
    const timeout = setTimeout(fail, RUN_TIMEOUT);
    const onAbort = () => fail();
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > MAX_OUTPUT) fail();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT) fail();
    });
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolveResult(stdout.trim());
    };
    child.on('error', () => finish(new Error('Docker check transport failed')));
    child.on('close', (code) =>
      finish(
        stopped || signal.aborted || code !== 0
          ? new Error('Fixed Docker check rejected, failed or exceeded limits')
          : undefined,
      ),
    );
  });
}

export async function runPatchChecksDocker(
  prepared: PreparedPatchChecks,
  recipeId: FixedPatchRecipe,
  filePath: string,
  proposedSha256: string,
  signal: AbortSignal,
): Promise<PatchCheckReceipt> {
  if (
    !RECIPES.has(recipeId) ||
    filePath.length > 160 ||
    !filePath ||
    !SHA.test(proposedSha256) ||
    /[,\r\n\0]/.test(filePath)
  ) {
    throw new Error('Unsupported Docker patch check request');
  }
  const area = recipeId.startsWith('API_') ? 'apps/api/src/' : 'apps/web/src/';
  if (
    !filePath.startsWith(area) ||
    filePath.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
  ) {
    throw new Error('Recipe may run only on approved source file');
  }
  const name = 'gym-dev-hub-patch-check-' + randomUUID();
  let outcome: Omit<PatchCheckReceipt, 'containerRemoved'> | null = null;
  let failed: unknown;
  let cleanupFailed = false;
  try {
    if (signal.aborted) throw new Error('Patch check canceled');
    await callDocker(
      [
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
        '--tmpfs=/workspace:rw,exec,nosuid,nodev,size=3072m,mode=1777',
        '--tmpfs=/results:rw,nosuid,nodev,noexec,size=32m,mode=1777',
        '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
        ...prepared.mounts.flatMap((mount) => [
          '--mount',
          'type=bind,source=' + mount.source + ',target=' + mount.target + ',readonly',
        ]),
        '--stop-timeout=3',
        '--entrypoint=/usr/bin/node',
        prepared.imageId,
        ENTRY,
        recipeId,
        filePath,
        proposedSha256,
      ],
      25_000,
    );
    validateRunnerIsolation(
      await callDocker(
        [
          'inspect',
          '--format',
          '{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.Config.User}}|{{.HostConfig.Privileged}}|{{.HostConfig.IpcMode}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}',
          name,
        ],
        8_000,
      ),
    );
    validatePatchCheckSecurity(
      await callDocker(
        [
          'inspect',
          '--format',
          '{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{json .HostConfig.Tmpfs}}',
          name,
        ],
        8_000,
      ),
    );
    validateRunnerMounts(
      await callDocker(['inspect', '--format', '{{json .Mounts}}', name], 8_000),
      prepared.mounts,
    );
    if (
      (await callDocker(['inspect', '--format', '{{.Image}}', name], 8_000)) !== prepared.imageId
    ) {
      throw new Error('Docker image substitution');
    }
    if (signal.aborted) throw new Error('Patch check canceled');
    outcome = validatePatchCheckReceipt(
      await attached(name, signal),
      recipeId,
      filePath,
      proposedSha256,
    );
    if ((await callDocker(['inspect', '--format', '{{.State.ExitCode}}', name], 8_000)) !== '0') {
      throw new Error('Nonzero fixed check exit');
    }
  } catch (error) {
    failed = error;
  } finally {
    try {
      await callDocker(['rm', '--force', name], 10_000);
    } catch {
      const stillThere = await callDocker(
        ['ps', '--all', '--quiet', '--filter', 'name=^' + name + '$'],
        8_000,
      ).catch(() => '__unknown__');
      cleanupFailed = Boolean(stillThere);
    }
  }
  if (cleanupFailed) throw new Error('Cannot prove Docker check container was removed');
  if (failed) throw failed;
  if (!outcome) throw new Error('Fixed patch check has no verified receipt');
  return { ...outcome, containerRemoved: true };
}
