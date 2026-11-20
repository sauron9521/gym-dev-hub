/**
 * CI-only: verify complete immutable Gym Platform snapshot, then rehydrate the
 * real @gym/api dependency graph from an independently staged pnpm store.
 * Runs pnpm as a package manager, never target scripts, Prisma or TS compiler.
 * Not reachable via the diagnostic runner protocol, HTTP, Codex, or task grants.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, lstat, readFile, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE = '/source';
const MANIFEST = '/manifest';
const STORE = '/store';
const WORK = '/workspace';
const RESULTS = '/results';
const PROJECT = join(WORK, 'project');
const LOCAL_STORE = join(WORK, '.pnpm-store');
const COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const MANIFEST_SHA256 = 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';
const MAX_STORE_FILES = 90000;
const MAX_STORE_BYTES = 1900 * 1024 * 1024;
const TMPFS_MAGIC = 0x01021994;
const REQUIRE_PACKAGES = Object.freeze({
  typescript: '6.0.3',
  prisma: '7.10.1',
  '@prisma/client': '7.10.1',
  '@prisma/adapter-pg': '7.10.1',
  bcrypt: '6.0.0',
  sharp: '0.35.5',
});

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function realDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Untrusted input directory');
  }
}

async function checkMounts() {
  const info = await readFile('/proc/self/mountinfo', 'utf8');
  const observed = new Map();
  for (const line of info.split('\n')) {
    const [first, second] = line.split(' - ');
    if (!second) continue;
    const parts = first.split(' ');
    if ([SOURCE, MANIFEST, STORE, WORK, RESULTS].includes(parts[4])) {
      observed.set(parts[4], { mount: parts[5].split(','), type: second.split(' ')[0] });
    }
  }
  for (const mount of [SOURCE, MANIFEST, STORE]) {
    await realDirectory(mount);
    if (!observed.get(mount)?.mount.includes('ro')) throw new Error('Source/store mount writable');
  }
  for (const mount of [WORK, RESULTS]) {
    await realDirectory(mount);
    const actual = observed.get(mount);
    if (
      actual?.type !== 'tmpfs' ||
      !['rw', 'nosuid', 'nodev', 'noexec'].every((flag) => actual.mount.includes(flag)) ||
      (await statfs(mount)).type !== TMPFS_MAGIC ||
      (await readdir(mount)).length !== 0
    ) {
      throw new Error('Scratch volume is unsafe or reused');
    }
  }
}

function run(command, args, cwd, timeout) {
  const task = spawnSync(command, args, {
    shell: false,
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: WORK,
      TMPDIR: WORK,
      TMP: WORK,
      TEMP: WORK,
      XDG_CACHE_HOME: join(WORK, '.cache'),
      XDG_DATA_HOME: join(WORK, '.local', 'share'),
      npm_config_update_notifier: 'false',
      CI: 'true',
    },
  });
  if (task.error || task.signal || task.status === null) throw new Error('Bounded process interrupted');
  return task;
}

async function verifyEntireSource() {
  const checked = run(
    '/usr/bin/node',
    ['/opt/gym-dev-hub/full-source-audit.mjs'],
    '/opt/gym-dev-hub',
    45000,
  );
  if (checked.status !== 0) throw new Error('Full source Git manifest verification failed');
  const result = JSON.parse(checked.stdout.trim());
  if (
    result.event !== 'immutable-full-source-snapshot-verified' ||
    result.sourceCommit !== COMMIT ||
    result.sourceTree !== TREE ||
    result.manifestSha256 !== MANIFEST_SHA256 ||
    result.trackedFiles !== 1258 ||
    result.sourceCodeExecuted !== false
  ) {
    throw new Error('Unexpected full source identity');
  }
}

async function inspectStore(path, depth, tally) {
  if (depth > 18) throw new Error('Store nesting is excessive');
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('Symlink in untrusted registry store');
  if (info.isDirectory()) {
    tally.directories++;
    if (tally.directories > MAX_STORE_FILES) throw new Error('Too many store directories');
    for (const name of await readdir(path)) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        throw new Error('Unsafe pnpm store entry');
      }
      await inspectStore(join(path, name), depth + 1, tally);
    }
  } else if (info.isFile()) {
    tally.files++;
    tally.bytes += info.size;
    if (tally.files > MAX_STORE_FILES || tally.bytes > MAX_STORE_BYTES) {
      throw new Error('Store exceeds reviewed resource limit');
    }
  } else {
    throw new Error('Unexpected device or socket in pnpm store');
  }
}

async function packageVersion(name) {
  const nodes = name.startsWith('@') ? name.split('/') : [name];
  const roots = [
    join(PROJECT, 'node_modules'),
    join(PROJECT, 'apps', 'api', 'node_modules'),
  ];
  for (const root of roots) {
    try {
      const bytes = await readFile(join(root, ...nodes, 'package.json'));
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (parsed.name === name) return parsed.version;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Expected installed package not found: ' + name);
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No task arguments permitted');
  await checkMounts();
  await verifyEntireSource();
  const root = JSON.parse(await readFile(join(SOURCE, 'package.json'), 'utf8'));
  const api = JSON.parse(await readFile(join(SOURCE, 'apps/api/package.json'), 'utf8'));
  const workspace = await readFile(join(SOURCE, 'pnpm-workspace.yaml'), 'utf8');
  if (
    root.packageManager !== 'pnpm@12.18.0' ||
    api.name !== '@gym/api' ||
    api.scripts?.typecheck !== 'tsc --noEmit -p tsconfig.build.json' ||
    !workspace.includes('nodeLinker: hoisted')
  ) {
    throw new Error('Unapproved target package recipe or workspace');
  }
  const pinnedLock = hash(await readFile(join(SOURCE, 'pnpm-lock.yaml')));
  const tally = { files: 0, directories: 0, bytes: 0 };
  await inspectStore(STORE, 0, tally);
  if (tally.files < 50) throw new Error('Incomplete real API dependency cache');

  // The original Git-pinned bind never becomes writable. All package-manager
  // operations happen exclusively on a disposable copy in private tmpfs.
  await cp(SOURCE, PROJECT, { recursive: true, dereference: false, force: false, errorOnExist: true });
  await cp(STORE, LOCAL_STORE, { recursive: true, dereference: false, force: false, errorOnExist: true });

  const installed = run(
    '/bin/sh',
    [
      '/usr/bin/devhub-pnpm',
      '--filter',
      '@gym/api',
      'install',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--trust-lockfile',
      '--store-dir',
      LOCAL_STORE,
    ],
    PROJECT,
    240000,
  );
  if (installed.status !== 0) {
    throw new Error(
      'Real API offline dependency install failed: ' +
        (installed.stderr || installed.stdout || 'unknown').slice(0, 850),
    );
  }
  for (const [name, version] of Object.entries(REQUIRE_PACKAGES)) {
    const actual = await packageVersion(name);
    if (actual !== version) throw new Error('Wrong resolved version for ' + name);
  }
  const after = hash(await readFile(join(PROJECT, 'pnpm-lock.yaml')));
  if (after !== pinnedLock) throw new Error('Pinned source lockfile was modified by install');
  const afterOriginal = hash(await readFile(join(SOURCE, 'pnpm-lock.yaml')));
  if (afterOriginal !== pinnedLock) throw new Error('Original source lockfile modified');

  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'real-api-dependency-cache-installed-offline',
      target: '@gym/api',
      commit: COMMIT,
      sourceTree: TREE,
      sourceManifestSha256: MANIFEST_SHA256,
      requiredPackageVersions: REQUIRE_PACKAGES,
      storeFiles: tally.files,
      storeBytes: tally.bytes,
      lockSha256: pinnedLock,
      frozenLockfile: true,
      offlineInstall: true,
      ignoreScripts: true,
      immutableOriginalSource: true,
      fullSnapshotVerified: true,
      gymPlatformProjectScriptsExecuted: false,
      prismaGenerated: false,
      typecheckExecuted: false,
      networkEnabled: false,
      operatorGrantConsumed: false,
      executionEnabled: false,
    }) + '\n',
  );
}

main().catch((error) => {
  process.stderr.write(
    'Offline API cache proof rejected: ' +
      (error instanceof Error ? error.message.slice(0, 900) : 'unknown') +
      '\n',
  );
  process.exitCode = 1;
});
