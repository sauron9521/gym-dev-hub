/**
 * CI-only native runtime smoke. No Hub/API/Codex entrypoint calls this module.
 * The source, manifest and pnpm store stay read-only; offline rehydration uses
 * /workspace (noexec), while only reviewed native packages are copied into a
 * separate disposable /native (exec) tmpfs. Fixed probes only, no user argv.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inspectInstalledNativeArtifacts } from './native-binary-inspect.mjs';

const SOURCE_COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const SOURCE_TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const SOURCE_MANIFEST = 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';
const ENGINE_SHA256 = 'c583d08ce5150fe39ff1d4a981c790e3eee8e1fbb432b80dba7606d74c1e56cf';
const ENGINE = '/engine/schema-engine';
const PROJECT = '/workspace/project';
const NATIVE = '/native';
const TMPFS_MAGIC = 0x01021994;
const MAX_FILES = 5000;
const MAX_BYTES = 128 * 1024 * 1024;

const PACKAGES = Object.freeze({
  bcrypt: '6.0.0',
  'node-gyp-build': null,
  sharp: '0.35.5',
  '@img/sharp-linuxmusl-x64': '0.35.5',
  '@img/sharp-libvips-linuxmusl-x64': '1.3.4',
  '@img/colour': null,
  'detect-libc': null,
  semver: null,
});

function run(command, args, cwd, timeout, extraEnv = {}) {
  const child = spawnSync(command, args, {
    cwd,
    shell: false,
    timeout,
    encoding: 'utf8',
    maxBuffer: 16000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/workspace',
      TMPDIR: '/workspace',
      TMP: '/workspace',
      TEMP: '/workspace',
      XDG_CACHE_HOME: '/workspace/.cache',
      XDG_DATA_HOME: '/workspace/.local/share',
      CI: 'true',
      npm_config_update_notifier: 'false',
      ...extraEnv,
    },
  });
  if (child.error || child.signal || child.status === null) {
    throw new Error('Bounded native runtime command interrupted');
  }
  return child;
}

async function checkNativeMount() {
  const mountinfo = await readFile('/proc/self/mountinfo', 'utf8');
  const line = mountinfo.split('\n').find((entry) => entry.split(' ')[4] === NATIVE);
  if (!line) throw new Error('Missing dedicated /native mount');
  const parts = line.split(' - ');
  const options = parts[0].split(' ')[5].split(',');
  if (
    parts[1]?.split(' ')[0] !== 'tmpfs' ||
    !['rw', 'nosuid', 'nodev'].every((flag) => options.includes(flag)) ||
    options.includes('noexec') ||
    (await statfs(NATIVE)).type !== TMPFS_MAGIC ||
    (await readdir(NATIVE)).length !== 0
  ) {
    throw new Error('Unsafe or reused executable native scratch mount');
  }
}

async function inspectTree(path, tally, depth = 0) {
  if (depth > 14) throw new Error('Native package nesting exceeds reviewed bounds');
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('Symlink in executable package subset');
  if (info.isDirectory()) {
    tally.files++;
    if (tally.files > MAX_FILES) throw new Error('Native package file-count quota exceeded');
    for (const name of await readdir(path)) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        throw new Error('Unsafe native package path');
      }
      await inspectTree(join(path, name), tally, depth + 1);
    }
  } else if (info.isFile()) {
    tally.files++;
    tally.bytes += info.size;
    if (tally.files > MAX_FILES || tally.bytes > MAX_BYTES) {
      throw new Error('Native package quota exceeded');
    }
  } else {
    throw new Error('Special file in native executable package subset');
  }
}

async function copyReviewedPackage(name, expectedVersion, tally) {
  const parts = name.split('/');
  let path;
  for (const root of [join(PROJECT, 'node_modules'), join(PROJECT, 'apps', 'api', 'node_modules')]) {
    const candidate = join(root, ...parts);
    try {
      await lstat(candidate);
      path = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!path) throw new Error('Missing reviewed native runtime dependency: ' + name);
  const meta = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  if (meta.name !== name || (expectedVersion !== null && meta.version !== expectedVersion)) {
    throw new Error('Unexpected native package/version: ' + name);
  }
  await inspectTree(path, tally);
  const destination = join(NATIVE, 'node_modules', ...parts);
  await mkdir(dirname(destination), { recursive: true });
  await cp(path, destination, {
    recursive: true,
    dereference: false,
    force: false,
    errorOnExist: true,
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Unexpected native runtime arguments');
  // Fail before any provisioning if the sole executable scratch mount is unsafe.
  await checkNativeMount();

  const setup = run(
    '/usr/bin/node',
    ['/opt/gym-dev-hub/offline-api-cache.mjs'],
    '/opt/gym-dev-hub',
    450000,
  );
  if (setup.status !== 0) {
    throw new Error('Immutable offline API provisioning failed before native load');
  }
  const proof = JSON.parse(setup.stdout.trim());
  if (
    proof.event !== 'real-api-dependency-cache-installed-offline' ||
    proof.commit !== SOURCE_COMMIT ||
    proof.sourceTree !== SOURCE_TREE ||
    proof.sourceManifestSha256 !== SOURCE_MANIFEST ||
    proof.offlineInstall !== true ||
    proof.ignoreScripts !== true ||
    proof.immutableOriginalSource !== true ||
    proof.fullSnapshotVerified !== true ||
    proof.executionEnabled !== false ||
    proof.prismaGenerated !== false ||
    proof.typecheckExecuted !== false
  ) {
    throw new Error('Unreviewed native execution source');
  }
  const engineBytes = await readFile(ENGINE);
  if (createHash('sha256').update(engineBytes).digest('hex') !== ENGINE_SHA256) {
    throw new Error('Pinned Prisma native engine digest mismatch');
  }
  const inventory = await inspectInstalledNativeArtifacts(PROJECT, ENGINE);
  if (inventory.allExpectedHeadersPresent !== true) {
    throw new Error('Missing pinned musl ELF packages before native execution');
  }

  const tally = { files: 0, bytes: 0 };
  for (const [name, version] of Object.entries(PACKAGES)) {
    await copyReviewedPackage(name, version, tally);
  }
  const probe = run(
    '/usr/bin/node',
    ['/opt/gym-dev-hub/native-runtime-fixture.mjs'],
    '/opt/gym-dev-hub',
    30000,
    {
      LD_LIBRARY_PATH: '/native/node_modules/@img/sharp-libvips-linuxmusl-x64/lib',
      SHARP_IGNORE_GLOBAL_LIBVIPS: '1',
    },
  );
  if (probe.status !== 0) {
    throw new Error('Fixed native addon runtime probe failed: ' + probe.stderr.slice(0, 1300));
  }
  const result = JSON.parse(probe.stdout.trim());
  if (
    result.event !== 'pinned-alpine-native-runtime-probe' ||
    result.bcryptVerified !== true ||
    result.sharpPngRoundTrip !== true ||
    result.nativePackagesLoaded !== true
  ) {
    throw new Error('Incomplete native addon runtime proof');
  }
  const engine = run(ENGINE, ['--version'], '/opt/gym-dev-hub', 20000);
  if (engine.status !== 0 || !engine.stdout.includes('schema-engine')) {
    throw new Error('Pinned Prisma schema-engine runtime probe failed');
  }

  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'ci-only-alpine-native-runtime-smoke',
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
      platform: 'alpine-linux-musl-x86_64',
      bcryptVerified: true,
      sharpPngRoundTrip: true,
      prismaEngineVersionOk: true,
      nativePackagesLoaded: true,
      nativeScratchExecutable: true,
      immutableSourceReadOnly: true,
      dependencyLifecycleScriptsExecuted: false,
      apiTypecheckExecuted: false,
      arbitraryTaskExecutionEnabled: false,
      operatorGrantConsumed: false,
      noNetwork: true,
      reviewedPackageCount: Object.keys(PACKAGES).length,
      reviewedPackageBytes: tally.bytes,
    }) + '\n',
  );
}

main().catch((error) => {
  process.stderr.write(
    'CI native runtime smoke rejected: ' +
      (error instanceof Error ? error.message.slice(0, 1300) : 'unknown') +
      '\n',
  );
  process.exitCode = 1;
});
