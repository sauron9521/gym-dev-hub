/**
 * CI-only first real Gym Platform source typecheck. Fixed source file set,
 * commit and Git object identities. Not exposed via the diagnostic runner,
 * NestJS endpoints or Codex. No Gym Platform package scripts execute.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const INPUT = '/input';
const FIXTURE = '/fixture';
const STORE = '/store';
const WORK = '/workspace';
const LOCAL_STORE = join(WORK, '.pnpm-store');
const COMMIT = '73b636f5d064c7f24b43607e0c8411e9161f8986';
const SRI =
  'sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw==';

const SOURCE = Object.freeze({
  'domain.ts': '4bfb3dd4455f6612eb818ad694ccbb7e56f743ce',
  'locales.ts': 'acdfbb8e07aa031e8ac0ca05e8d3fb6026ffc77a',
  'workout-analytics-window.ts': 'cab78200f48bfe265ff374df9eebe4fd3902684e',
  'exercises-pagination.ts': 'bc1a7817f2cfcf0f6bf3672502d0212cb843b276',
});
const TOOLCHAIN = Object.freeze({
  'package.json': 'fd42b2310e5b547735a3b5a975cc0cda1c5b3426',
  'pnpm-workspace.yaml': '77125aa68b16356bb413d241df61f535e8bad266',
  'pnpm-lock.yaml': 'd84cf67c1cabc0f585d1c9be670be4d4a09eb76d',
});
const FILES = Object.freeze(Object.keys(SOURCE));
const MAX_FILE_BYTES = 8192;
const MAX_STORE_BYTES = 150 * 1024 * 1024;
const MAX_STORE_FILES = 8192;

function gitBlob(bytes) {
  return createHash('sha1')
    .update(Buffer.from('blob ' + bytes.length + '\0'))
    .update(bytes)
    .digest('hex');
}

async function assertDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe input directory');
}

async function pinnedFile(root, filename, expected) {
  const file = join(root, filename);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_FILE_BYTES) {
    throw new Error('Missing, oversized or non-regular pinned file');
  }
  const data = await readFile(file);
  if (data.length !== info.size || gitBlob(data) !== expected) {
    throw new Error('Source Git blob mismatch: ' + filename);
  }
  return data;
}

async function scanStore(dir, depth, totals) {
  if (depth > 16) throw new Error('Excessive store nesting');
  const st = await lstat(dir);
  if (st.isSymbolicLink()) throw new Error('Symlink in dependency store');
  if (st.isDirectory()) {
    totals.dirs++;
    if (totals.dirs > MAX_STORE_FILES) throw new Error('Too many store directories');
    for (const file of await readdir(dir)) {
      if (!file || file === '.' || file === '..' || file.includes('/') || file.includes('\\')) {
        throw new Error('Unexpected store entry');
      }
      await scanStore(join(dir, file), depth + 1, totals);
    }
  } else if (st.isFile()) {
    totals.files++;
    totals.bytes += st.size;
    if (totals.files > MAX_STORE_FILES || totals.bytes > MAX_STORE_BYTES) {
      throw new Error('Dependency store exceeds quota');
    }
  } else {
    throw new Error('Unsupported store object type');
  }
}

function run(executable, args, timeout) {
  const process = spawnSync(executable, args, {
    cwd: WORK,
    shell: false,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32768,
    env: {
      HOME: WORK,
      PATH: '/usr/bin:/bin',
      TMPDIR: WORK,
      TEMP: WORK,
      TMP: WORK,
      XDG_CACHE_HOME: join(WORK, '.cache'),
      XDG_DATA_HOME: join(WORK, '.local', 'share'),
      CI: 'true',
      npm_config_update_notifier: 'false',
    },
  });
  if (process.error || process.signal || process.status === null) {
    throw new Error('Bounded toolchain command was interrupted');
  }
  return process;
}

async function assertAbsent(path) {
  try {
    await lstat(join(WORK, path));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Lifecycle script marker unexpectedly created');
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No caller arguments permitted');
  for (const directory of [INPUT, FIXTURE, STORE]) await assertDirectory(directory);
  const entries = (await readdir(INPUT)).sort();
  if (JSON.stringify(entries) !== JSON.stringify([...FILES].sort())) {
    throw new Error('Unexpected file in pinned Gym Platform source snapshot');
  }

  const source = new Map();
  for (const [name, gitSha] of Object.entries(SOURCE)) {
    source.set(name, await pinnedFile(INPUT, name, gitSha));
  }
  const toolchain = new Map();
  for (const [name, gitSha] of Object.entries(TOOLCHAIN)) {
    toolchain.set(name, await pinnedFile(FIXTURE, name, gitSha));
  }

  const packageManifest = JSON.parse(toolchain.get('package.json').toString('utf8'));
  const workspaceConfig = toolchain.get('pnpm-workspace.yaml').toString('utf8');
  const lockText = toolchain.get('pnpm-lock.yaml').toString('utf8');
  const resolution = '  typescript@6.0.3:\n    resolution: {integrity: ' + SRI + '}';
  if (
    packageManifest.name !== '@devhub/typescript-toolchain-proof' ||
    packageManifest.engines?.pnpm !== '12.18.0' ||
    JSON.stringify(packageManifest.devDependencies) !== JSON.stringify({ typescript: '6.0.3' }) ||
    !workspaceConfig.includes('nodeLinker: isolated') ||
    lockText.split(resolution).length !== 2 ||
    (lockText.match(/sha512-[A-Za-z0-9+/=]+/g) ?? []).length !== 1
  ) {
    throw new Error('Unexpected TypeScript toolchain fixture configuration');
  }

  const sizes = { dirs: 0, files: 0, bytes: 0 };
  await scanStore(STORE, 0, sizes);
  if (sizes.files < 2) throw new Error('Empty TypeScript dependency store');

  await mkdir(join(WORK, 'src'), { mode: 0o700 });
  for (const [filename, data] of source) {
    await writeFile(join(WORK, 'src', filename), data, { mode: 0o600, flag: 'wx' });
  }
  for (const [filename, data] of toolchain) {
    await writeFile(join(WORK, filename), data, { mode: 0o600, flag: 'wx' });
  }

  const lockBefore = createHash('sha256').update(toolchain.get('pnpm-lock.yaml')).digest('hex');
  await cp(STORE, LOCAL_STORE, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
  });

  const install = run(
    '/bin/sh',
    [
      '/usr/bin/devhub-pnpm',
      'install',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--trust-lockfile',
      '--store-dir',
      LOCAL_STORE,
    ],
    90000,
  );
  if (install.status !== 0) {
    throw new Error('Offline TypeScript toolchain installation failed');
  }
  const tsPackage = JSON.parse(
    (await readFile(join(WORK, 'node_modules', 'typescript', 'package.json'))).toString('utf8'),
  );
  if (tsPackage.name !== 'typescript' || tsPackage.version !== '6.0.3') {
    throw new Error('Unexpected compiler version');
  }

  const config = {
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      noEmit: true,
      types: [],
      skipLibCheck: true,
      incremental: false,
    },
    files: FILES.map((name) => 'src/' + name),
  };
  await writeFile(join(WORK, 'tsconfig.json'), JSON.stringify(config), {
    mode: 0o600,
    flag: 'wx',
  });

  // This compiles reviewed real Gym Platform TypeScript, but never evaluates
  // the source at runtime or launches any Gym Platform application script.
  const compiler = join(WORK, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = run('/usr/bin/node', [compiler, '--noEmit', '-p', 'tsconfig.json'], 45000);
  if (result.status !== 0) {
    throw new Error(
      'Pinned Gym Platform source did not typecheck: ' + (result.stdout || result.stderr).slice(0, 800),
    );
  }
  const after = await readFile(join(WORK, 'pnpm-lock.yaml'));
  if (createHash('sha256').update(after).digest('hex') !== lockBefore) {
    throw new Error('Frozen toolchain lockfile mutated');
  }
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
    await assertAbsent(script + '-ran');
  }
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'pinned-gym-platform-source-typechecked',
      sourceCommit: COMMIT,
      typecheckedFiles: FILES,
      compiler: 'typescript@6.0.3',
      sourceBlobsVerified: FILES.length,
      sourceExecuted: false,
      packageCompilerExecuted: true,
      entireGymPlatformChecked: false,
      targetProjectScriptsExecuted: false,
      lifecycleScriptsExecuted: false,
      networkEnabled: false,
      offlineInstall: true,
      sourceOnlyRead: true,
      apiTaskExecutionEnabled: false,
      fixedRecipe: 'TYPECHECK_PINNED_SOURCE_SUBSET',
      lockSha256: lockBefore,
      storeFiles: sizes.files,
    }) + '\n',
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message.slice(0, 850) : 'unknown error';
  process.stderr.write('Pinned Gym Platform source typecheck rejected: ' + message + '\n');
  process.exitCode = 1;
});
