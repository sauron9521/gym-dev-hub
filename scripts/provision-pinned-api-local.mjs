/**
 * Opt-in local provisioning of the one immutable Gym Platform API_TYPECHECK
 * bundle. No HTTP route calls this tool. The trusted-network stage runs ONLY
 * in an unprivileged, read-only-root Docker container with one empty writable
 * bind and NO host credentials, Docker socket, or existing project checkout.
 * The actual TypeScript validation runs in a separate offline container.
 *
 * Usage: node scripts/provision-pinned-api-local.mjs --prepare
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginPinnedStage, finishPinnedStage } from './pinned-stage-ledger.mjs';

export const FIXED = Object.freeze({
  commit: '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a',
  tree: '2c140e1e740b3dd8cc7582db726f46b54b73b334',
  manifest: 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b',
  engine: 'c583d08ce5150fe39ff1d4a981c790e3eee8e1fbb432b80dba7606d74c1e56cf',
  image: 'gym-dev-hub-node-runner:v1',
  provisioner: 'gym-dev-hub-local-provisioner:v1',
});
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CAPTURE = 64 * 1024;
const SHA_IMAGE = /^sha256:[a-f0-9]{64}$/;
// Recovery tooling may inspect/prune only containers bearing BOTH explicit labels.
export const PROVISIONING_LABEL = 'org.gym-dev-hub.local-provisioning';
export const PROVISIONING_SCOPE = 'pinned-api-v1';
export const PROVISIONING_PHASE_LABEL = 'org.gym-dev-hub.local-provisioning-phase';
export const PROVISIONING_CHECKOUT_LABEL = 'org.gym-dev-hub.local-provisioning-checkout';
// Prevent cleanup from another clone/worktree from selecting this checkout's containers.
export const PROVISIONING_CHECKOUT = createHash('sha256').update(ROOT).digest('hex');

function noDockerCredentials() {
  const allowed = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ];
  const env = Object.fromEntries(
    allowed.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
  );
  env.NO_COLOR = '1';
  return env;
}

function command(executable, args, timeout = 30000, capture = MAX_CAPTURE) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      env: noDockerCredentials(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let diagnostic = '';
    let settled = false;
    let interrupted = false;
    const deadline = setTimeout(() => {
      interrupted = true;
      child.kill();
    }, timeout);
    const consume = (value, chunk) => {
      const next = value + chunk.toString('utf8');
      if (Buffer.byteLength(next) > capture) {
        interrupted = true;
        child.kill();
        return next.slice(-capture);
      }
      return next;
    };
    child.stdout.on('data', (chunk) => {
      output = consume(output, chunk);
    });
    child.stderr.on('data', (chunk) => {
      diagnostic = consume(diagnostic, chunk);
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) rejectRun(error);
      else resolveRun(output.trim());
    };
    child.on('error', () => finish(new Error('Reviewed local executable unavailable')));
    child.on('close', (code) =>
      finish(
        interrupted || code !== 0
          ? new Error(
              'Bounded local provisioning command failed (exit=' +
                code +
                ', diagnostic=' +
                diagnostic.slice(-700).replace(/[\r\n]/g, ' ') +
                ')',
            )
          : undefined,
      ),
    );
  });
}

async function docker(...args) {
  // Docker Desktop may briefly exceed 30s during image/VM activation after
  // provisioning; keep a hard bound without mistaking warm-up for failure.
  return command('docker', args, 90000);
}

export async function checkLocalDocker() {
  const endpoint = await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
  if (
    !(process.platform === 'win32'
      ? endpoint.startsWith('npipe:////./pipe/')
      : endpoint.startsWith('unix://'))
  )
    throw new Error('Remote Docker daemon forbidden for local provisioning');
  const platform = await docker('info', '--format', '{{.OSType}}|{{.Architecture}}');
  if (!['linux|x86_64', 'linux|amd64'].includes(platform)) {
    throw new Error('Only local Linux AMD64 Docker Engine is supported');
  }
}

async function ensureNoSymlinkAncestors(path) {
  let cursor = resolve(path);
  while (true) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Redirected or non-directory provisioning root');
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  await realpath(path);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function verifyLocalProof(proof) {
  if (
    !proof ||
    proof.protocol !== 1 ||
    proof.event !== 'pinned-api-typecheck-local-executed' ||
    proof.recipe !== 'API_TYPECHECK' ||
    proof.sourceCommit !== FIXED.commit ||
    proof.sourceTree !== FIXED.tree ||
    proof.sourceManifestSha256 !== FIXED.manifest ||
    proof.typescriptVersion !== '6.0.3' ||
    proof.prismaGenerated !== true ||
    proof.apiTypecheckExecuted !== true ||
    proof.typecheckExitCode !== 0 ||
    proof.networkEnabled !== false ||
    proof.sourceReadOnly !== true ||
    proof.dependencyLifecycleScriptsExecuted !== false ||
    proof.arbitraryCommandsEnabled !== false ||
    proof.delegatedAuthorization !== 'host-service-only' ||
    proof.operatorGrantConsumedInsideContainer !== false ||
    proof.hostGrantVerificationInsideContainer !== false ||
    !Number.isSafeInteger(proof.stdoutBytes) ||
    proof.stdoutBytes > 65536 ||
    proof.stdoutBytes < 0 ||
    !Number.isSafeInteger(proof.stderrBytes) ||
    proof.stderrBytes > 65536 ||
    proof.stderrBytes < 0
  )
    throw new Error('Local fixed compiler proof missing or untrusted');
}

export function verifyImageMetadata(raw, expected, role) {
  const [id, user, os, arch, mode, entry] = raw.split('|');
  if (
    raw.split('|').length !== 6 ||
    id !== expected ||
    !SHA_IMAGE.test(id) ||
    user !== '65534:65534' ||
    os !== 'linux' ||
    arch !== 'amd64' ||
    (role === 'runner' &&
      (mode !== 'disabled' || entry !== '["/usr/bin/node","/opt/gym-dev-hub/runner.mjs"]')) ||
    (role === 'provisioner' &&
      (mode !== 'fixed-pinned-source-only' ||
        entry !== '["/bin/sh","/opt/gym-dev-hub/stage-pinned-api.sh"]'))
  )
    throw new Error('Unexpected Docker image metadata or image substitution');
}

async function imageMetadata(tag, role) {
  const field =
    role === 'runner' ? 'org.gym-dev-hub.runner.execution' : 'org.gym-dev-hub.provisioner.mode';
  const format =
    '{{.Id}}|{{.Config.User}}|{{.Os}}|{{.Architecture}}|' +
    '{{index .Config.Labels "' +
    field +
    '"}}|{{json .Config.Entrypoint}}';
  const details = await docker('image', 'inspect', tag, '--format', format);
  const id = details.split('|')[0];
  verifyImageMetadata(details, id, role);
  return id;
}

async function build(tag, dockerfile, context, role) {
  // Only the two repository-owned, fixed Dockerfiles may run. No build args,
  // secrets, context mounts, remote cache or caller-selected base/image.
  await command(
    'docker',
    ['build', '--pull=false', '--tag', tag, '--file', dockerfile, context],
    480000,
    256 * 1024,
  );
  return imageMetadata(tag, role);
}

function mountEntries(bundle) {
  return [
    ['source', '/source'],
    ['manifest', '/manifest'],
    ['store', '/store'],
    ['engine', '/engine'],
  ]
    .map(([dir, target]) => [
      '--mount',
      'type=bind,source=' + join(bundle, dir) + ',target=' + target + ',readonly',
    ])
    .flat();
}

function reviewedDockerOptions() {
  return [
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
  ];
}

function checkIsolation(host) {
  if (
    host.NetworkMode !== 'none' ||
    host.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    host.IpcMode !== 'none' ||
    host.PidsLimit !== 128 ||
    host.Memory !== 5368709120 ||
    host.NanoCpus !== 2000000000 ||
    JSON.stringify(host.CapDrop?.map((x) => x.toUpperCase())) !== '["ALL"]' ||
    !host.SecurityOpt?.some((x) => String(x).startsWith('no-new-privileges')) ||
    Object.keys(host.Tmpfs ?? {})
      .sort()
      .join(',') !== '/results,/tmp,/workspace' ||
    Object.values(host.Tmpfs ?? {}).some(
      (x) => !['noexec', 'nosuid', 'nodev'].every((flag) => x.includes(flag)),
    ) ||
    host.Mounts?.length !== 4 ||
    host.Mounts.some(
      (x) =>
        x.Type !== 'bind' ||
        x.ReadOnly !== true ||
        !['/source', '/manifest', '/store', '/engine'].includes(x.Target),
    )
  )
    throw new Error('Offline validation Docker isolation does not match reviewed policy');
}

export function verifyProvisionerIsolation(host) {
  if (
    host.NetworkMode !== 'bridge' ||
    host.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    host.IpcMode !== 'none' ||
    host.PidsLimit !== 256 ||
    host.Memory !== 5368709120 ||
    host.NanoCpus !== 2000000000 ||
    JSON.stringify(host.CapDrop?.map((x) => x.toUpperCase())) !== '["ALL"]' ||
    !host.SecurityOpt?.some((x) => String(x).startsWith('no-new-privileges')) ||
    Object.keys(host.Tmpfs ?? {}).join(',') !== '/tmp' ||
    !['noexec', 'nosuid', 'nodev'].every((x) => host.Tmpfs['/tmp']?.includes(x)) ||
    host.Mounts?.length !== 1 ||
    host.Mounts[0]?.Type !== 'bind' ||
    host.Mounts[0]?.Target !== '/bundle' ||
    host.Mounts[0]?.ReadOnly === true
  )
    throw new Error('Trusted network stage had unsafe Docker isolation or host mounts');
}

async function stageInDocker(stage, imageId) {
  const name = 'gym-devhub-pinned-stage-' + randomUUID();
  let cleanupFailed = false;
  let staged = false;
  try {
    await command(
      'docker',
      [
        'create',
        '--name',
        name,
        '--label',
        PROVISIONING_LABEL + '=' + PROVISIONING_SCOPE,
        '--label',
        PROVISIONING_PHASE_LABEL + '=stage',
        '--label',
        PROVISIONING_CHECKOUT_LABEL + '=' + PROVISIONING_CHECKOUT,
        '--pull=never',
        '--network=bridge',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=65534:65534',
        '--ipc=none',
        '--pids-limit=256',
        '--memory=5g',
        '--cpus=2',
        '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=3072m,mode=1777',
        '--mount',
        'type=bind,source=' + stage + ',target=/bundle',
        imageId,
      ],
      90000,
    );
    const host = JSON.parse(await docker('inspect', '--format', '{{json .HostConfig}}', name));
    verifyProvisionerIsolation(host);
    const observed = await docker('inspect', '--format', '{{.Image}}|{{.Config.User}}', name);
    if (observed !== imageId + '|65534:65534') {
      throw new Error('Provisioner image or UID was substituted');
    }
    const binds = JSON.parse(await docker('inspect', '--format', '{{json .Mounts}}', name));
    if (
      !Array.isArray(binds) ||
      binds.length !== 1 ||
      binds[0]?.Type !== 'bind' ||
      binds[0]?.Destination !== '/bundle' ||
      binds[0]?.RW !== true
    )
      throw new Error('Provisioner writable bind is not exactly the temporary output folder');
    const output = await command('docker', ['start', '--attach', name], 1800000, 256 * 1024);
    const exit = await docker('inspect', '--format', '{{.State.ExitCode}}', name);
    staged = exit === '0' && output.includes('PINNED_LOCAL_API_BUNDLE_STAGED_V1');
  } finally {
    try {
      await docker('rm', '--force', name);
    } catch {
      const remaining = await docker(
        'ps',
        '--all',
        '--quiet',
        '--filter',
        'name=^' + name + '$',
      ).catch(() => '__unknown__');
      cleanupFailed = Boolean(remaining);
    }
  }
  if (cleanupFailed || !staged) {
    throw new Error('Pinned source/store staging failed or Docker cleanup was unverified');
  }
}

async function smoke(bundle, imageId) {
  const name = 'gym-devhub-provision-check-' + randomUUID();
  let cleanupError = false;
  let result;
  try {
    await command(
      'docker',
      [
        'create',
        '--name',
        name,
        '--label',
        PROVISIONING_LABEL + '=' + PROVISIONING_SCOPE,
        '--label',
        PROVISIONING_PHASE_LABEL + '=offline-smoke',
        '--label',
        PROVISIONING_CHECKOUT_LABEL + '=' + PROVISIONING_CHECKOUT,
        '--pull=never',
        ...reviewedDockerOptions(),
        ...mountEntries(bundle),
        '--stop-timeout=3',
        '--entrypoint=/usr/bin/node',
        imageId,
        '/opt/gym-dev-hub/api-typecheck-local.mjs',
      ],
      90000,
    );
    const host = JSON.parse(await docker('inspect', '--format', '{{json .HostConfig}}', name));
    checkIsolation(host);
    const actual = await docker('inspect', '--format', '{{.Image}}|{{.Config.User}}', name);
    if (actual !== imageId + '|65534:65534') {
      throw new Error('Docker runtime substituted image or user');
    }
    const mounts = JSON.parse(await docker('inspect', '--format', '{{json .Mounts}}', name));
    if (
      !Array.isArray(mounts) ||
      mounts.length !== 4 ||
      mounts.some((mount) => mount.Type !== 'bind' || mount.RW !== false) ||
      mounts
        .map((mount) => mount.Destination)
        .sort()
        .join(',') !== '/engine,/manifest,/source,/store'
    )
      throw new Error('Runtime bind mounts not read-only or incorrect destinations');
    const stdout = await command('docker', ['start', '--attach', name], 570000);
    const exit = await docker('inspect', '--format', '{{.State.ExitCode}}', name);
    if (exit !== '0') throw new Error('Fixed runtime command exited unsuccessfully');
    const proof = JSON.parse(stdout.trim());
    verifyLocalProof(proof);
    result = proof;
  } finally {
    try {
      await docker('rm', '--force', name);
    } catch {
      const remaining = await docker(
        'ps',
        '--all',
        '--quiet',
        '--filter',
        'name=^' + name + '$',
      ).catch(() => '__unknown__');
      cleanupError = Boolean(remaining);
    }
  }
  if (cleanupError || !result) throw new Error('Cannot prove offline smoke and container cleanup');
  return result;
}

export function verifyStoreArchiveListing(raw, verbose) {
  if (
    typeof raw !== 'string' ||
    raw.length > 16 * 1024 * 1024 ||
    typeof verbose !== 'string' ||
    verbose.length > 16 * 1024 * 1024
  ) {
    throw new Error('Unexpected pnpm store archive index');
  }
  const paths = raw.split(/\r?\n/).filter(Boolean);
  const types = verbose.split(/\r?\n/).filter(Boolean);
  if (paths.length < 50 || paths.length > 100000 || types.length !== paths.length) {
    throw new Error('Unbounded or incomplete pnpm store archive');
  }
  for (let index = 0; index < paths.length; index++) {
    const entry = paths[index];
    const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    if (
      (normalized !== '.' && !normalized.startsWith('./')) ||
      normalized.includes('\\') ||
      normalized.includes(':') ||
      normalized.includes('\0') ||
      normalized.includes('\r') ||
      normalized.includes('\n') ||
      normalized.length > 350 ||
      normalized.split('/').some((part) => part === '..') ||
      !['-', 'd'].includes(types[index]?.[0])
    ) {
      throw new Error('Unsafe path, symlink or special type in pnpm store archive');
    }
  }
}

async function inspectExtractedStore(path, tally, depth = 0) {
  if (depth > 18) throw new Error('Store nesting exceeds reviewed limit');
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) throw new Error('Redirected symlink in offline store');
  if (entry.isDirectory()) {
    tally.directories++;
    if (tally.directories > 90000) throw new Error('Too many store directories');
    for (const name of await readdir(path)) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        throw new Error('Unsafe offline store entry');
      }
      await inspectExtractedStore(join(path, name), tally, depth + 1);
    }
  } else if (entry.isFile()) {
    tally.files++;
    tally.bytes += entry.size;
    if (tally.files > 90000 || tally.bytes > 1900 * 1024 * 1024) {
      throw new Error('Offline store exceeded fixed file or size limit');
    }
  } else {
    throw new Error('Special file in offline store');
  }
}

async function unpackPinnedStore(bundle) {
  const archive = join(bundle, 'pnpm-store.tar.gz');
  const details = await lstat(archive);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size < 1000 ||
    details.size > 1900 * 1024 * 1024
  ) {
    throw new Error('Missing or oversized pinned pnpm store transport');
  }
  const listed = await command('tar', ['-tzf', archive], 180000, 16 * 1024 * 1024);
  const verbose = await command('tar', ['-tvzf', archive], 180000, 16 * 1024 * 1024);
  verifyStoreArchiveListing(listed, verbose);
  const destination = join(bundle, 'store');
  await mkdir(destination);
  await command('tar', ['-xzf', archive, '-C', destination], 600000);
  const tally = { files: 0, directories: 0, bytes: 0 };
  await inspectExtractedStore(destination, tally);
  if (tally.files < 50) throw new Error('Incomplete extracted pinned dependency store');
  await rm(archive);
}

async function verifyBundle(bundle) {
  const paths = ['source', 'manifest', 'store', 'engine'];
  for (const dir of paths) await ensureNoSymlinkAncestors(join(bundle, dir));
  const manifestFile = join(bundle, 'manifest', 'tracked-files.bin');
  if ((await sha256(manifestFile)) !== FIXED.manifest) {
    throw new Error('Local source Git manifest digest mismatch');
  }
  const engineFile = join(bundle, 'engine', 'schema-engine');
  const engineStat = await stat(engineFile);
  if (
    !engineStat.isFile() ||
    engineStat.size < 1000000 ||
    engineStat.size > 180000000 ||
    (await sha256(engineFile)) !== FIXED.engine
  )
    throw new Error('Local Prisma engine digest or length mismatch');
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'apps/api/package.json',
    'apps/api/tsconfig.build.json',
  ];
  for (const path of files) {
    const info = await lstat(join(bundle, 'source', path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Missing pinned project file');
  }
}

function generatedEnvironment(bundle, imageId) {
  return [
    '# Generated without secrets. Review before manually enabling execution.',
    'DEV_HUB_TASK_RUNNER_IMAGE_ID=' + imageId,
    'DEV_HUB_TASK_SOURCE_SNAPSHOT=' + join(bundle, 'source'),
    'DEV_HUB_TASK_SOURCE_MANIFEST=' + join(bundle, 'manifest'),
    'DEV_HUB_TASK_PNPM_STORE=' + join(bundle, 'store'),
    'DEV_HUB_TASK_PRISMA_ENGINE=' + join(bundle, 'engine'),
    '# Separately configure operator secret and explicitly enable grants/execution.',
    '# DEV_HUB_ENABLE_TASK_GRANTS=true',
    '# DEV_HUB_ENABLE_TASK_EXECUTION=true',
    '',
  ].join('\n');
}

async function prepare() {
  await checkLocalDocker();
  const root = join(ROOT, '.local', 'pinned-api-runner');
  await mkdir(root, { recursive: true });
  await ensureNoSymlinkAncestors(root);
  const final = join(root, 'pinned-' + FIXED.commit.slice(0, 12));
  try {
    await lstat(final);
    throw new Error('Pinned bundle already exists; refusing to overwrite: ' + final);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // The ownership journal and exclusive process lock are created BEFORE
  // granting the fixed network stage write access to this temporary folder.
  const stageRun = await beginPinnedStage(root, PROVISIONING_CHECKOUT);
  const stage = stageRun.stage;
  // It is newly created, empty and private to this invocation. The container
  // runs as UID 65534 and must be able to stage bytes on Linux bind mounts.
  await chmod(stage, 0o777);
  let published = false;
  try {
    const provisionerId = await build(
      FIXED.provisioner,
      join(ROOT, 'packages', 'local-provisioner', 'Dockerfile'),
      join(ROOT, 'packages', 'local-provisioner'),
      'provisioner',
    );
    await stageInDocker(stage, provisionerId);
    // No longer let the networked stage write to the bundle. Lock its parent
    // before host verification and the independent offline validation.
    await chmod(stage, 0o700);
    await unpackPinnedStore(stage);
    await verifyBundle(stage);
    const runnerId = await build(
      FIXED.image,
      join(ROOT, 'packages', 'runner', 'Dockerfile'),
      join(ROOT, 'packages', 'runner'),
      'runner',
    );
    const proof = await smoke(stage, runnerId);
    await chmod(stage, 0o700);
    const receipt = {
      protocol: 1,
      event: 'local-pinned-api-runner-provisioned',
      sourceCommit: FIXED.commit,
      sourceTree: FIXED.tree,
      sourceManifestSha256: FIXED.manifest,
      prismaEngineSha256: FIXED.engine,
      runnerImageId: runnerId,
      provisionerImageId: provisionerId,
      typecheckVerified: true,
      containerRemoved: true,
      operatorGrantConsumed: false,
      taskExecutionEnabled: false,
      createdAt: new Date().toISOString(),
    };
    // Publish atomically only AFTER the receipt and env example exist.
    await writeFile(join(stage, 'provisioning.json'), JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(
      join(stage, 'task-typecheck.env.example'),
      generatedEnvironment(final, runnerId),
      { flag: 'wx', mode: 0o600 },
    );
    await rename(stage, final);
    published = true;
    process.stdout.write(JSON.stringify({ ...receipt, bundleDirectory: final }) + '\n');
  } finally {
    // Preserve the ownership journal if deleting this run's scratch fails;
    // a later explicit recovery can prove directory identity before removal.
    if (!published) await rm(stage, { recursive: true, force: true });
    await finishPinnedStage(stageRun);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--prepare') {
    process.stderr.write('Usage: node scripts/provision-pinned-api-local.mjs --prepare\n');
    process.exitCode = 2;
  } else {
    prepare().catch((error) => {
      process.stderr.write(
        'Pinned local provisioning refused: ' +
          (error instanceof Error ? error.message.slice(0, 1000) : 'unknown') +
          '\n',
      );
      process.exitCode = 1;
    });
  }
}
