/**
 * CI-only offline fixture proof. NOT reachable through the runner protocol/API.
 * Accepts no arguments. Only known, trusted fixture files from /input.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const INPUT = '/input';
const OUTPUT = '/workspace';
const MAX_TOTAL_BYTES = 32_768;
const FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'packages/offline-lib/package.json',
];
const SHA256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readTrustedFixture(path) {
  let cursor = INPUT;
  const components = path.split('/');
  for (const component of components.slice(0, -1)) {
    cursor = join(cursor, component);
    const dir = await lstat(cursor);
    if (!dir.isDirectory() || dir.isSymbolicLink()) {
      throw new Error('Fixture contains unsafe directory');
    }
  }
  const file = join(INPUT, path);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TOTAL_BYTES) {
    throw new Error('Fixture contains unsafe file');
  }
  const bytes = await readFile(file);
  if (bytes.length !== stat.size) {
    throw new Error('Fixture changed while reading');
  }
  return bytes;
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No arguments are permitted');
  const source = new Map();
  let totalBytes = 0;
  for (const file of FILES) {
    const bytes = await readTrustedFixture(file);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Fixture exceeded byte cap');
    source.set(file, bytes);
  }
  const root = JSON.parse(source.get('package.json').toString('utf8'));
  const local = JSON.parse(source.get('packages/offline-lib/package.json').toString('utf8'));
  const workspace = source.get('pnpm-workspace.yaml').toString('utf8');
  const lock = source.get('pnpm-lock.yaml').toString('utf8');
  if (
    root.name !== '@devhub/offline-fixture' ||
    root.engines?.pnpm !== '12.18.0' ||
    root.dependencies?.['@devhub/offline-lib'] !== 'workspace:*' ||
    local.name !== '@devhub/offline-lib' ||
    !/^lockfileVersion: '9\.0'/m.test(lock) ||
    !lock.includes('link:packages/offline-lib') ||
    !workspace.includes("  - 'packages/*'")
  ) {
    throw new Error('Unexpected fixture or dependency metadata');
  }

  const lockHash = SHA256(source.get('pnpm-lock.yaml'));
  for (const [file, bytes] of source) {
    const target = join(OUTPUT, file);
    if (file.includes('/')) {
      await mkdir(join(OUTPUT, 'packages', 'offline-lib'), { recursive: true, mode: 0o700 });
    }
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }

  const result = spawnSync(
    '/bin/sh',
    ['/usr/bin/devhub-pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'],
    {
      cwd: OUTPUT,
      shell: false,
      timeout: 30_000,
      maxBuffer: 8192,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: OUTPUT,
        TMPDIR: OUTPUT,
        TMP: OUTPUT,
        TEMP: OUTPUT,
        XDG_CACHE_HOME: join(OUTPUT, '.cache'),
        XDG_DATA_HOME: join(OUTPUT, '.local', 'share'),
        npm_config_store_dir: join(OUTPUT, '.pnpm-store'),
        npm_config_update_notifier: 'false',
        CI: 'true',
      },
    },
  );
  if (result.error || result.status !== 0 || result.signal) {
    const detail = (result.stderr || result.stdout || result.error?.message || 'unknown error')
      .toString()
      .slice(0, 500);
    throw new Error('Offline pnpm failed: ' + detail);
  }

  const installed = JSON.parse(
    (
      await readFile(join(OUTPUT, 'node_modules', '@devhub', 'offline-lib', 'package.json'))
    ).toString('utf8'),
  );
  const afterLock = await readFile(join(OUTPUT, 'pnpm-lock.yaml'));
  if (installed.name !== '@devhub/offline-lib' || SHA256(afterLock) !== lockHash) {
    throw new Error('Dependency or lockfile changed during install');
  }
  for (const marker of ['root-script-executed', 'local-script-executed']) {
    try {
      await lstat(join(OUTPUT, marker));
      throw new Error('Forbidden dependency lifecycle script executed');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'offline-deps-provisioned',
      executionEnabled: false,
      lockSha256: lockHash,
      packagesLinked: 1,
      scriptsSkipped: true,
      externalDownloadsAllowed: false,
    }) + '\n',
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message.slice(0, 600) : 'unknown error';
  // CI-only fixture does not receive project files, registry tokens, or secrets.
  process.stderr.write('Offline provisioning fixture rejected: ' + message + '\n');
  process.exitCode = 1;
});
