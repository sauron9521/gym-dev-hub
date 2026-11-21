/**
 * EXPLICIT, MANUAL-ONLY Linux SIGKILL/restart recovery of a disposable real
 * Nest HTTP -> Docker WEB_TEST check. Never SIGKILL production Hub or delete
 * containers/stages that cannot be proven to belong to this one fixture.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(ROOT, 'scripts/launch-sigkill-recovery-worker.mjs');
const FIXTURE_PREFIX = '/tmp/gym-dev-hub-sigkill-';
const DOCKER_PREFIX = 'gym-dev-hub-patch-check-';
const RECIPE = 'WEB_TEST';
const MAX_WAIT_MS = 180_000;
const POLL_MS = 250;
const wait = (ms) =>
  new Promise((resolveWait) => {
    // Timeouts are only fallback guards; an already finished probe must not
    // remain alive waiting for a losing Promise.race timer.
    const timer = setTimeout(resolveWait, ms);
    timer.unref();
  });

export function validateSigkillCli(argv, env, platform, uid) {
  if (argv.length !== 1 || argv[0] !== '--confirm-isolated-sigkill-recovery')
    throw new Error('Explicit isolated SIGKILL confirmation required');
  if (platform !== 'linux' || uid === 0) throw new Error('Non-root Linux operator required');
  if (
    !/^sha256:[a-f0-9]{64}$/.test(env.DEV_HUB_PATCH_CHECK_IMAGE_ID ?? '') ||
    !/^\//.test(env.DEV_HUB_PATCH_CHECK_PNPM_STORE ?? '')
  )
    throw new Error('Pinned image and absolute verified offline store are required');
  for (const name of ['DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    if (env[name]) throw new Error('Remote or TLS Docker is refused');
  }
  if (env.DOCKER_HOST && env.DOCKER_HOST !== 'unix:///var/run/docker.sock')
    throw new Error('Remote Docker host is refused');
  if (env.DOCKER_CONTEXT && env.DOCKER_CONTEXT !== 'default')
    throw new Error('Remote Docker context is refused');
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: ROOT,
    input: options.input,
    encoding: options.encoding ?? 'utf8',
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 120 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error || result.status !== 0)
    throw new Error('Isolated recovery preflight or Docker command failed');
  return result.stdout;
}
function docker(args) {
  const value = command('docker', args, { maxBuffer: 32 * 1024 });
  return typeof value === 'string' ? value.trim() : value.toString('utf8').trim();
}
function matchingContainers() {
  const raw = docker([
    'ps',
    '--all',
    '--format',
    '{{.Names}}',
    '--filter',
    'name=^' + DOCKER_PREFIX,
  ]);
  if (!raw) return [];
  const names = raw.split('\n').filter(Boolean);
  if (names.some((name) => !/^gym-dev-hub-patch-check-[a-f0-9-]{36}$/.test(name)))
    throw new Error('Unexpected fixed-check container name');
  return names;
}

/**
 * Validate the container's Docker engine identity, immutable pinned image,
 * non-root isolation, and SOURCE bind under our newly created fixture.
 * Return only the exact disposable store stage root it used.
 */
export function verifyOwnedContainer(
  inspection,
  name,
  fixtureRoot,
  imageId,
  storeKey,
  requireRunning = true,
) {
  if (
    !/^gym-dev-hub-patch-check-[a-f0-9-]{36}$/.test(name) ||
    !/^\/tmp\/gym-dev-hub-sigkill-[A-Za-z0-9_-]+$/.test(fixtureRoot) ||
    !/^[a-f0-9]{64}$/.test(storeKey) ||
    !/^sha256:[a-f0-9]{64}$/.test(imageId)
  )
    throw new Error('Unsafe fixture or Docker ownership evidence');
  if (
    !inspection ||
    typeof inspection !== 'object' ||
    inspection.Name !== '/' + name ||
    inspection.Image !== imageId ||
    inspection.Config?.User !== '65534:65534' ||
    inspection.HostConfig?.NetworkMode !== 'none' ||
    inspection.HostConfig?.ReadonlyRootfs !== true ||
    inspection.HostConfig?.Privileged !== false ||
    (requireRunning && inspection.State?.Running !== true) ||
    !Array.isArray(inspection.Mounts)
  )
    throw new Error('Docker container is not the isolated fixed recipe');
  const source = inspection.Mounts.find((m) => m.Destination === '/source');
  const store = inspection.Mounts.find((m) => m.Destination === '/store');
  const ownedSource = fixtureRoot + '/.gym-dev-hub-check-stage-';
  const storeMatch = /^\/tmp\/(gym-dev-hub-patch-store-[a-zA-Z0-9_-]+)\/([a-f0-9]{64})$/;
  const matched = storeMatch.exec(store?.Source ?? '');
  if (
    !source?.Source?.startsWith(ownedSource) ||
    source.RW !== false ||
    store?.RW !== false ||
    !matched ||
    matched[2] !== storeKey ||
    inspection.Mounts.length !== 2
  )
    throw new Error('Cannot prove Docker source and store stage ownership');
  return '/tmp/' + matched[1];
}

async function assertOwnedPath(path, prefix, owner) {
  if (!path.startsWith(prefix) || path === prefix || (await realpath(path)) !== path)
    throw new Error('Unsafe cleanup stage path');
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner)
    throw new Error('Foreign stage ownership');
}
async function ensureSocket() {
  const stat = await lstat('/var/run/docker.sock');
  if (!stat.isSocket() || (stat.mode & 0o007) !== 0) throw new Error('Unsafe Docker socket');
  if (
    docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']) !==
    'unix:///var/run/docker.sock'
  )
    throw new Error('Only the local Docker socket is allowed');
  if (docker(['info', '--format', '{{.OSType}}']) !== 'linux')
    throw new Error('Non-Linux Docker engine refused');
  if (matchingContainers().length !== 0)
    throw new Error('Existing fixed Docker containers require owner review first');
}

function launchWorker(phase, fixture, secrets) {
  // Do not forward the owner's complete .env to disposable children.
  // In particular, the live API, GitHub and database credentials must not
  // exist in this test worker's environment at all.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    DEV_HUB_PATCH_CHECK_IMAGE_ID: process.env.DEV_HUB_PATCH_CHECK_IMAGE_ID,
    DEV_HUB_PATCH_CHECK_PNPM_STORE: process.env.DEV_HUB_PATCH_CHECK_PNPM_STORE,
    DEV_HUB_SIGKILL_FIXTURE_DIR: fixture,
    DEV_HUB_PATCH_CHECK_STATE_DIR: join(fixture, 'audit'),
    DEV_HUB_PATCH_CHECK_OPERATOR_SECRET: secrets.operator,
    DEV_HUB_SIGKILL_REVIEW_SECRET: secrets.review,
    DEV_HUB_SIGKILL_CHILD: 'EXPLICIT_ISOLATED_WORKER',
    DEV_HUB_ENABLE_PATCH_CHECKS: 'true',
  };
  const child = spawn(process.execPath, [WORKER, phase], {
    cwd: ROOT,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Bounded, never log raw child output. Child only prints fixed status
  // markers; guard in case an external dependency accidentally logs secrets.
  let output = '';
  let stderrBytes = 0;
  child.stdout.on('data', (chunk) => {
    output = (output + chunk.toString('utf8')).slice(-512);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
  });
  const exit = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
    child.once('error', () => resolveExit({ code: null, signal: 'ERROR' }));
  });
  return { child, exit, getOutput: () => output, getStderrSize: () => stderrBytes };
}

async function durableAttempted(fixture) {
  const file = join(fixture, 'audit', 'audit.jsonl');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!raw.endsWith('\n') || Buffer.byteLength(raw) > 10_000)
    throw new Error('Truncated or oversized fixture audit');
  const events = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  if (events.length > 2 || events.some((x) => !['issued', 'attempted'].includes(x.event)))
    throw new Error('Fixture check completed before SIGKILL');
  return (
    events.length === 2 &&
    events[0].event === 'issued' &&
    events[1].event === 'attempted' &&
    events[0].grantId === events[1].grantId &&
    events[1].runId !== null
  );
}

export async function main(argv = process.argv.slice(2)) {
  validateSigkillCli(argv, process.env, process.platform, process.getuid?.());
  await ensureSocket();
  const origin = command('git', ['remote', 'get-url', 'origin']).trim();
  if (
    ![
      'git@github.com:sauron9521/gym-dev-hub.git',
      'https://github.com/sauron9521/gym-dev-hub.git',
    ].includes(origin)
  )
    throw new Error('Untrusted source repository');
  const sourceCommit = command('git', ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Invalid public source commit');
  const originalStore = resolve(process.env.DEV_HUB_PATCH_CHECK_PNPM_STORE);
  const storeKey = basename(originalStore);
  if (!/^[a-f0-9]{64}$/.test(storeKey)) throw new Error('Unsafe pinned store key');

  const fixture = await mkdtemp(FIXTURE_PREFIX);
  const owner = process.getuid();
  let child = null;
  let ownedName = null;
  let ownedStoreStage = null;
  let pendingError = null;
  let recoveryVerified = false;
  try {
    // Only public committed Git bytes. NEVER use the dirty primary checkout.
    await chmod(fixture, 0o711);
    const source = join(fixture, 'source');
    await mkdir(source, { mode: 0o700 });
    const archive = command('git', ['archive', '--format=tar', sourceCommit], { encoding: null });
    command('tar', ['-xf', '-', '-C', source], { input: archive });
    const commitFile = await open(
      join(fixture, 'commit'),
      constants.O_EXCL | constants.O_CREAT | constants.O_WRONLY,
      0o600,
    );
    try {
      await commitFile.writeFile(sourceCommit + '\n');
      await commitFile.sync();
    } finally {
      await commitFile.close();
    }

    const secrets = {
      operator: randomBytes(32).toString('hex'),
      review: randomBytes(32).toString('hex'),
    };
    child = launchWorker('run', fixture, secrets);
    const started = Date.now();
    while (Date.now() - started < MAX_WAIT_MS) {
      const attempted = await durableAttempted(fixture);
      const names = matchingContainers();
      if (names.length > 1) throw new Error('Concurrent Docker fixed-check container appeared');
      if (names.length === 1 && attempted) {
        const inspect = JSON.parse(docker(['inspect', '--format', '{{json .}}', names[0]]));
        try {
          const stage = verifyOwnedContainer(
            inspect,
            names[0],
            fixture,
            process.env.DEV_HUB_PATCH_CHECK_IMAGE_ID,
            storeKey,
          );
          await assertOwnedPath(stage, '/tmp/gym-dev-hub-patch-store-', owner);
          ownedName = names[0];
          ownedStoreStage = stage;
          break;
        } catch (error) {
          // A container may exist but not have started yet. Reject a
          // *different* mount or image immediately; allow just State.Running
          // transition during creation.
          if (
            inspect.State?.Running !== true &&
            inspect.Mounts?.some(
              (m) =>
                m.Destination === '/source' &&
                m.Source.startsWith(fixture + '/.gym-dev-hub-check-stage-'),
            )
          ) {
            await wait(POLL_MS);
            continue;
          }
          throw error;
        }
      }
      const state = child.child.exitCode;
      if (state !== null || child.child.signalCode !== null)
        throw new Error('Child exited before a running Docker check could be proven');
      await wait(POLL_MS);
    }
    if (!ownedName || !ownedStoreStage)
      throw new Error('Could not prove a running owned Docker check before timeout');

    // SIGKILL only the exact PID returned by spawn() in this function;
    // never touch the operator's real compiled API or any process group.
    if (!child.child.pid || !child.child.kill('SIGKILL'))
      throw new Error('Failed to SIGKILL the exact isolated worker');
    const killed = await Promise.race([
      child.exit,
      wait(12_000).then(() => {
        throw new Error('Isolated child did not exit');
      }),
    ]);
    if (killed.signal !== 'SIGKILL') throw new Error('Isolated worker did not die from SIGKILL');
    if (!(await durableAttempted(fixture)))
      throw new Error('Interrupted audit changed after SIGKILL');

    // Fresh Node process + fresh Nest application reading the SAME test-only
    // journal must report interrupted, and reject the old grant replay.
    const recovery = launchWorker('recover', fixture, secrets);
    const recovered = await Promise.race([
      recovery.exit,
      wait(25_000).then(() => {
        throw new Error('Restarted recovery probe timed out');
      }),
    ]);
    if (
      recovered.code !== 0 ||
      !recovery.getOutput().includes('SIGKILL_RECOVERY_HTTP_INTERRUPTED_VERIFIED')
    )
      throw new Error('Restart did not prove durable interrupted history');

    recoveryVerified = true;
  } catch (error) {
    pendingError = error;
  } finally {
    // Always attempt to kill only the exact child spawned here. Never kill
    // other PIDs by name or port, even if the fixture failed.
    if (child && child.child.exitCode === null && child.child.signalCode === null) {
      child.child.kill('SIGKILL');
      await Promise.race([child.exit, wait(10_000)]).catch(() => undefined);
    }
    try {
      // Only remove the previously INSPECTED, exact-owned Docker container.
      // Recheck identity immediately before deletion; if uncertain, leave it
      // for the owner and fail rather than deleting a foreign container.
      if (ownedName && ownedStoreStage) {
        const still = matchingContainers();
        if (still.length && (still.length !== 1 || still[0] !== ownedName))
          throw new Error('Foreign Docker check container appeared during recovery');
        if (still.length === 1) {
          const final = JSON.parse(docker(['inspect', '--format', '{{json .}}', ownedName]));
          verifyOwnedContainer(
            final,
            ownedName,
            fixture,
            process.env.DEV_HUB_PATCH_CHECK_IMAGE_ID,
            storeKey,
            false,
          );
          docker(['rm', '--force', ownedName]);
        }
        if (matchingContainers().length) throw new Error('Owned Docker container remained');
        await assertOwnedPath(ownedStoreStage, '/tmp/gym-dev-hub-patch-store-', owner);
        await rm(ownedStoreStage, { recursive: true, force: false });
      } else if (matchingContainers().length) {
        throw new Error('Unverified Docker container requires manual recovery');
      }
      await assertOwnedPath(fixture, FIXTURE_PREFIX, owner);
      await rm(fixture, { recursive: true, force: false });
    } catch {
      pendingError = new Error(
        'Cleanup not provable: manual isolated Docker/stage inspection required',
      );
    }
  }
  if (pendingError) throw pendingError;
  if (!recoveryVerified) throw new Error('SIGKILL recovery lacked verified evidence');
  process.stdout.write(
    JSON.stringify({
      status: 'isolated-real-sigkill-recovery-verified',
      recipe: RECIPE,
      sourceCommit,
      sigkillConfirmed: true,
      recoveredAuditStatus: 'interrupted',
      sameGrantReplayDenied: true,
      ownedDockerContainerRemoved: true,
      temporaryStagesRemoved: true,
      productionApiKilled: false,
      productionAuditWritten: false,
    }) + '\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('ISOLATED_SIGKILL_RECOVERY_REJECTED; no secrets or source paths logged\n');
    process.exitCode = 1;
  });
}
