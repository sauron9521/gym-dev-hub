/**
 * CI-only, fixed real two-package offline pnpm install proof.
 * No API entrypoint or support for executing arbitrary project scripts.
 */
import { readdir, lstat, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const INPUT = '/input';
const STORE = '/store';
const OUTPUT = '/workspace';
const TARGET_STORE = join(OUTPUT, '.pnpm-store');
const FILES = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
const PINS = Object.freeze({
  'is-number@7.0.0': 'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==',
  'to-regex-range@5.0.1': 'sha512-65P7iz6X5yEr1cwcgvQxbbIw7Uk3gOy5dIdtZ4rDveLqhrdJP+Li/Hx6tyK0NEb+2GCyneCMJiGqrADCSNk8sQ==',
});
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_STORE_FILES = 4096;

async function readFixture(name) {
  const path = join(INPUT, name);
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size < 1 || st.size > 32768) {
    throw new Error('Unsafe fixture input');
  }
  const data = await readFile(path);
  if (data.length !== st.size) throw new Error('Fixture changed while reading');
  return data;
}

function checkFixture(source) {
  const root = JSON.parse(source.get('package.json').toString('utf8'));
  const config = source.get('pnpm-workspace.yaml').toString('utf8');
  const lock = source.get('pnpm-lock.yaml').toString('utf8');
  if (
    root.name !== '@devhub/real-pair-proof' ||
    root.engines?.pnpm !== '12.18.0' ||
    JSON.stringify(root.dependencies) !== JSON.stringify({ 'to-regex-range': '5.0.1' }) ||
    !config.includes('nodeLinker: isolated') ||
    !config.includes("  - '.'") ||
    !lock.startsWith("lockfileVersion: '9.0'\n") ||
    !lock.includes('specifier: 5.0.1') ||
    !lock.includes('is-number: 7.0.0')
  ) {
    throw new Error('Unexpected dependency fixture metadata');
  }
  for (const [pkg, sri] of Object.entries(PINS)) {
    const resolution = '  ' + pkg + ':\n    resolution: {integrity: ' + sri + '}';
    if (lock.split(resolution).length !== 2 || lock.split('  ' + pkg + ':').length !== 3) {
      throw new Error('Fixture resolution differs from independently pinned SRI');
    }
  }
  const digests = lock.match(/sha512-[A-Za-z0-9+/=]+/g) ?? [];
  if (digests.length !== 2 || !Object.values(PINS).every((pin) => digests.includes(pin))) {
    throw new Error('Unexpected package graph or integrity count');
  }
  return createHash('sha256').update(source.get('pnpm-lock.yaml')).digest('hex');
}

async function inspectStore(path, depth, tally) {
  if (depth > 14) throw new Error('Store depth exceeds limit');
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new Error('Store symlink detected');
  if (st.isDirectory()) {
    tally.directories++;
    if (tally.directories > MAX_STORE_FILES) throw new Error('Too many store directories');
    for (const name of await readdir(path)) {
      if (name === '.' || name === '..' || !name || name.includes('/') || name.includes('\\')) {
        throw new Error('Unsafe store entry');
      }
      await inspectStore(join(path, name), depth + 1, tally);
    }
  } else if (st.isFile()) {
    tally.files++;
    tally.bytes += st.size;
    if (tally.files > MAX_STORE_FILES || tally.bytes > MAX_STORE_BYTES) {
      throw new Error('Store size or file count exceeded');
    }
  } else {
    throw new Error('Unsupported store object type');
  }
}

async function readJson(path) {
  return JSON.parse((await readFile(path)).toString('utf8'));
}

async function ensureMissing(path) {
  try {
    await lstat(path);
    throw new Error('Unapproved lifecycle script wrote a marker');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Arguments are not accepted');
  const fixtureDir = await lstat(INPUT);
  const storeDir = await lstat(STORE);
  if (
    !fixtureDir.isDirectory() || fixtureDir.isSymbolicLink() ||
    !storeDir.isDirectory() || storeDir.isSymbolicLink()
  ) {
    throw new Error('Input and store must be real directories');
  }
  const source = new Map();
  for (const name of FILES) source.set(name, await readFixture(name));
  const lockSha256 = checkFixture(source);
  const tally = { files: 0, directories: 0, bytes: 0 };
  await inspectStore(STORE, 0, tally);
  if (tally.files < 2) throw new Error('Offline store is unexpectedly empty');

  for (const [name, bytes] of source) {
    await writeFile(join(OUTPUT, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  await mkdir(TARGET_STORE, { mode: 0o700 });
  await cp(STORE, TARGET_STORE, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
  });

  const proc = spawnSync(
    '/bin/sh',
    ['/usr/bin/devhub-pnpm', 'install', '--offline', '--frozen-lockfile',
      '--ignore-scripts', '--store-dir', TARGET_STORE],
    {
      cwd: OUTPUT,
      shell: false,
      timeout: 60000,
      maxBuffer: 16384,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: OUTPUT,
        TMPDIR: OUTPUT,
        TMP: OUTPUT,
        TEMP: OUTPUT,
        XDG_CACHE_HOME: join(OUTPUT, '.cache'),
        XDG_DATA_HOME: join(OUTPUT, '.local', 'share'),
        npm_config_update_notifier: 'false',
        CI: 'true',
      },
    },
  );
  if (proc.error || proc.status !== 0 || proc.signal) {
    const detail = (proc.stderr || proc.stdout || proc.error?.message || 'unknown')
      .toString().slice(0, 500);
    throw new Error('Frozen offline installation failed: ' + detail);
  }

  const direct = await readJson(join(OUTPUT, 'node_modules', 'to-regex-range', 'package.json'));
  const indirect = await readJson(
    join(OUTPUT, 'node_modules', '.pnpm', 'to-regex-range@5.0.1',
      'node_modules', 'is-number', 'package.json'),
  );
  if (
    direct.name !== 'to-regex-range' ||
    direct.version !== '5.0.1' ||
    direct.dependencies?.['is-number'] !== '^7.0.0' ||
    indirect.name !== 'is-number' ||
    indirect.version !== '7.0.0'
  ) {
    throw new Error('Actual installed dependency graph differs from pinned versions');
  }
  const lockAfter = await readFile(join(OUTPUT, 'pnpm-lock.yaml'));
  if (createHash('sha256').update(lockAfter).digest('hex') !== lockSha256) {
    throw new Error('Frozen lockfile changed');
  }
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
    await ensureMissing(join(OUTPUT, name + '-ran'));
  }
  process.stdout.write(JSON.stringify({
    protocol: 1,
    event: 'real-offline-dependencies-installed',
    packageCount: 2,
    directPackages: 1,
    transitivePackages: 1,
    packageVersions: ['to-regex-range@5.0.1', 'is-number@7.0.0'],
    lockSha256,
    storeFilesCopied: tally.files,
    storeBytesCopied: tally.bytes,
    offline: true,
    frozenLockfile: true,
    lifecycleScriptsExecuted: false,
    projectScriptsExecuted: false,
    externalNetworkEnabled: false,
    gymPlatformSourceMounted: false,
    executionEnabled: false,
  }) + '\n');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message.slice(0, 650) : 'unknown';
  process.stderr.write('Real two-package offline proof rejected: ' + message + '\n');
  process.exitCode = 1;
});
