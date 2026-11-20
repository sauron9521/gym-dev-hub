/**
 * CI-only sandbox exercise of a pinned real TypeScript compiler on a tiny,
 * reviewed fixture. This DOES execute the npm-published TypeScript compiler
 * inside isolated Docker. Never callable through runner.mjs, API or UI.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, lstat, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const INPUT = '/input';
const STORE = '/store';
const WORK = '/workspace';
const LOCAL_STORE = join(WORK, '.pnpm-store');
const FILES = Object.freeze({
  'package.json': 'fd42b2310e5b547735a3b5a975cc0cda1c5b3426',
  'pnpm-workspace.yaml': '77125aa68b16356bb413d241df61f535e8bad266',
  'pnpm-lock.yaml': 'd84cf67c1cabc0f585d1c9be670be4d4a09eb76d',
  'tsconfig.json': 'e559f75533c2ef3811f58f640d52c2e3329c8a23',
  'tsconfig.reject.json': '187ab28c1ace8910c784f10579290919ba18a2c3',
  'src/good.ts': '2ba3f4c92f8070778b3c5b9e26aad0ce4dbd8925',
  'src/bad.ts': 'a8c21386bd2f32b28a1009b9169255ec0009d61f',
});
const PACKAGE = 'typescript@6.0.3';
const SRI =
  'sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw==';
const MAX_FILE_BYTES = 32768;
const MAX_STORE_FILES = 8000;
const MAX_STORE_BYTES = 130 * 1024 * 1024;

function gitHash(bytes) {
  return createHash('sha1')
    .update(Buffer.from('blob ' + bytes.length + '\0'))
    .update(bytes)
    .digest('hex');
}

async function directory(path) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe directory');
}

async function checkedInput(name, expectedHash) {
  if (name.includes('/')) await directory(join(INPUT, 'src'));
  const file = join(INPUT, name);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
    throw new Error('Unsafe fixture file');
  }
  const bytes = await readFile(file);
  if (bytes.length !== stat.size || gitHash(bytes) !== expectedHash) {
    throw new Error('Unreviewed fixture Git blob: ' + name);
  }
  return bytes;
}

async function inspectStore(path, depth, tally) {
  if (depth > 15) throw new Error('Too deeply nested store');
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new Error('Store symlink rejected');
  if (st.isDirectory()) {
    tally.directories++;
    if (tally.directories > MAX_STORE_FILES) throw new Error('Store has too many directories');
    for (const item of await readdir(path)) {
      if (!item || item.includes('/') || item.includes('\\')) throw new Error('Unsafe store entry');
      await inspectStore(join(path, item), depth + 1, tally);
    }
  } else if (st.isFile()) {
    tally.files++;
    tally.bytes += st.size;
    if (tally.files > MAX_STORE_FILES || tally.bytes > MAX_STORE_BYTES) {
      throw new Error('Offline TypeScript store exceeds limits');
    }
  } else {
    throw new Error('Unsupported filesystem object in store');
  }
}

function invoke(cmd, args, timeoutMs) {
  const result = spawnSync(cmd, args, {
    cwd: WORK,
    shell: false,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16384,
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
  if (result.error || result.signal) throw new Error('Toolchain process interrupted');
  return result;
}

async function assertMissing(name) {
  try {
    await lstat(join(WORK, name));
    throw new Error('Forbidden lifecycle marker was created');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No command arguments are allowed');
  await directory(INPUT);
  await directory(STORE);

  const contents = new Map();
  for (const [name, hash] of Object.entries(FILES)) {
    contents.set(name, await checkedInput(name, hash));
  }
  const root = JSON.parse(contents.get('package.json').toString('utf8'));
  const lock = contents.get('pnpm-lock.yaml').toString('utf8');
  const workspace = contents.get('pnpm-workspace.yaml').toString('utf8');
  const expected = '  ' + PACKAGE + ':\n    resolution: {integrity: ' + SRI + '}';
  if (
    root.name !== '@devhub/typescript-toolchain-proof' ||
    root.engines?.pnpm !== '12.18.0' ||
    JSON.stringify(root.devDependencies) !== JSON.stringify({ typescript: '6.0.3' }) ||
    !workspace.includes('nodeLinker: isolated') ||
    !lock.startsWith("lockfileVersion: '9.0'\n") ||
    lock.split(expected).length !== 2 ||
    (lock.match(/sha512-[A-Za-z0-9+/=]+/g) ?? []).length !== 1
  ) {
    throw new Error('Untrusted TypeScript toolchain resolution');
  }
  const lockHash = createHash('sha256').update(contents.get('pnpm-lock.yaml')).digest('hex');
  const tally = { files: 0, directories: 0, bytes: 0 };
  await inspectStore(STORE, 0, tally);
  if (tally.files < 2) throw new Error('Empty TypeScript store');

  await mkdir(join(WORK, 'src'), { mode: 0o700 });
  for (const [name, bytes] of contents) {
    await writeFile(join(WORK, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  await cp(STORE, LOCAL_STORE, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
  });

  const installed = invoke(
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
  if (installed.status !== 0) {
    throw new Error(
      'Offline TypeScript install failed: ' +
        (installed.stderr || installed.stdout || 'unknown').slice(0, 600),
    );
  }

  const installedPkg = JSON.parse(
    (await readFile(join(WORK, 'node_modules', 'typescript', 'package.json'))).toString('utf8'),
  );
  if (installedPkg.name !== 'typescript' || installedPkg.version !== '6.0.3') {
    throw new Error('Wrong TypeScript compiler provisioned');
  }
  const tsc = join(WORK, 'node_modules', 'typescript', 'bin', 'tsc');
  const good = invoke('/usr/bin/node', [tsc, '--noEmit', '-p', 'tsconfig.json'], 45000);
  if (good.status !== 0) {
    throw new Error('Valid TypeScript fixture unexpectedly failed: ' + (good.stdout || good.stderr).slice(0, 600));
  }
  const rejected = invoke('/usr/bin/node', [tsc, '--noEmit', '-p', 'tsconfig.reject.json'], 45000);
  if (
    rejected.status === 0 ||
    rejected.status === null ||
    !(rejected.stdout + rejected.stderr).includes('TS2322')
  ) {
    throw new Error('Compiler did not reject the intentional TypeScript type error');
  }

  const after = await readFile(join(WORK, 'pnpm-lock.yaml'));
  if (createHash('sha256').update(after).digest('hex') !== lockHash) {
    throw new Error('Frozen lockfile changed');
  }
  for (const marker of ['preinstall', 'install', 'postinstall', 'prepare']) {
    await assertMissing(marker + '-ran');
  }
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'pinned-typescript-compiler-verified',
      package: PACKAGE,
      fixtureChecks: 2,
      passedTypechecks: 1,
      expectedTypeErrors: 1,
      expectedDiagnostic: 'TS2322',
      toolchainExecuted: true,
      gymPlatformSourceMounted: false,
      gymPlatformScriptsExecuted: false,
      lifecycleScriptsExecuted: false,
      installOffline: true,
      frozenLockfile: true,
      networkAccess: false,
      apiExecutionEnabled: false,
      lockSha256: lockHash,
      storeFiles: tally.files,
      storeBytes: tally.bytes,
    }) + '\n',
  );
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message.slice(0, 700) : 'unknown';
  process.stderr.write('Pinned TypeScript smoke rejected: ' + msg + '\n');
  process.exitCode = 1;
});
