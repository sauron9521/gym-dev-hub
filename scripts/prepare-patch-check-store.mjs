/**
 * Manual, trusted-host provisioning of a bounded pnpm store for fixed Docker
 * API/Web checks. Network is permitted ONLY during pnpm fetch on the host.
 * Does not touch the global pnpm store, execute package scripts or expose a
 * new API command; Docker still installs offline with no network.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POLICY = Object.freeze({
  pnpmVersion: '12.18.0',
  maxFiles: 80_000,
  maxBytes: 1_600 * 1024 * 1024,
  requiredManifestPaths: Object.freeze([
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    'apps/api/package.json',
    'apps/web/package.json',
    'packages/contracts/package.json',
    'packages/tsconfig/package.json',
  ]),
});
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = join(ROOT, 'apps/api/.local');
const TARGET = join(LOCAL, 'patch-check-pnpm-stores');
const SHA = /^[0-9a-f]{64}$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function storeKey(lockBytes) {
  return sha256(
    Buffer.concat([
      Buffer.from('gym-dev-hub:patch-check:pnpm12.18.0:linux-x64:v1\0'),
      Buffer.from(lockBytes),
    ]),
  );
}

function requireHost() {
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    Number(process.versions.node.split('.')[0]) < 24
  ) {
    throw new Error('This pinned store provisioner supports Linux x64 only');
  }
}

async function shaFile(file, hash, expected) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.size !== expected.size
    ) {
      throw new Error('Pinned package file changed before hashing');
    }
    let seen = 0;
    for await (const part of handle.createReadStream({ autoClose: false })) {
      hash.update(part);
      seen += part.length;
    }
    const after = await handle.stat();
    if (
      seen !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('Pinned package file changed during hashing');
  } finally {
    await handle.close();
  }
}

/** Read-only inventory + deterministic digest. No store symlinks or special files. */
export async function inspectStore(storePath) {
  const root = resolve(storePath);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(root)) !== root) {
    throw new Error('Expected a real canonical pnpm store directory');
  }
  const digest = createHash('sha256');
  let files = 0;
  let bytes = 0;
  let hasIndex = false;
  let hasBlobs = false;
  async function walk(folder) {
    for (const item of (await readdir(folder)).sort()) {
      const file = join(folder, item);
      const rel = relative(root, file).split('\\').join('/');
      // pnpm stores project bookkeeping symlinks here. Never stage or validate
      // that directory as part of the content-addressable package closure.
      if (rel === 'v11/projects') continue;
      const meta = await lstat(file);
      if (meta.isSymbolicLink()) throw new Error('Symlink in pinned store');
      if (meta.isDirectory()) {
        await walk(file);
      } else if (meta.isFile()) {
        files++;
        bytes += meta.size;
        if (files > POLICY.maxFiles || bytes > POLICY.maxBytes) {
          throw new Error('Pinned store exceeds fixed Docker store bounds');
        }
        if (rel === 'v11/index.db' && meta.size > 0) hasIndex = true;
        if (rel.startsWith('v11/files/') && meta.size > 0) hasBlobs = true;
        digest.update(rel + '\0' + meta.size + '\0');
        await shaFile(file, digest, meta);
        digest.update('\0');
      } else {
        throw new Error('Unsupported file in pinned store');
      }
    }
  }
  await walk(root);
  if (!hasIndex || !hasBlobs) throw new Error('Incomplete pinned pnpm v11 store');
  return { files, bytes, digest: digest.digest('hex') };
}

function plainEnv(home) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    COREPACK_HOME: join(process.env.HOME ?? '', '.cache/node/corepack'),
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    CI: 'true',
    NODE_ENV: 'development',
    npm_config_update_notifier: 'false',
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local'),
  };
}

async function runPnpm(args, cwd, home, maxMs = 180_000) {
  return new Promise((done, fail) => {
    const child = spawn('pnpm', args, {
      cwd,
      env: plainEnv(home),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, maxMs);
    const append = (chunk) => {
      // Package metadata and source logs are untrusted; never echo raw output.
      out += chunk.toString('utf8');
      if (out.length > 128_000) {
        timedOut = true;
        child.kill();
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', () => {
      clearTimeout(timer);
      fail(new Error('pnpm executable not available'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) fail(new Error('Bounded pnpm dependency operation failed'));
      else done(out.trim());
    });
  });
}

async function mirrorManifests(target) {
  for (const rel of POLICY.requiredManifestPaths) {
    const destination = join(target, rel);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(join(ROOT, rel), destination);
  }
}

async function lockInfo() {
  const lock = await readFile(join(ROOT, 'pnpm-lock.yaml'));
  const key = storeKey(lock);
  if (!SHA.test(key)) throw new Error('Invalid pinned lock hash');
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  if (pkg.packageManager !== 'pnpm@' + POLICY.pnpmVersion) {
    throw new Error('Unexpected project pnpm version');
  }
  return { lockSha256: sha256(lock), key };
}

async function ensureParent() {
  await mkdir(LOCAL, { recursive: true, mode: 0o700 });
  await mkdir(TARGET, { recursive: true, mode: 0o700 });
  const real = await realpath(TARGET);
  if (real !== TARGET) throw new Error('Redirected pinned store parent');
}

async function verify() {
  requireHost();
  const info = await lockInfo();
  const store = join(TARGET, info.key);
  const manifest = JSON.parse(await readFile(store + '.json', 'utf8'));
  if (
    manifest.protocol !== 1 ||
    manifest.lockSha256 !== info.lockSha256 ||
    manifest.storeKey !== info.key ||
    manifest.pnpmVersion !== POLICY.pnpmVersion ||
    manifest.platform !== 'linux-x64' ||
    !SHA.test(manifest.storeDigest)
  )
    throw new Error('Pinned store manifest does not match the current lockfile');
  const observed = await inspectStore(store);
  if (
    observed.digest !== manifest.storeDigest ||
    observed.files !== manifest.files ||
    observed.bytes !== manifest.bytes
  )
    throw new Error('Pinned store content drift detected');
  return { path: store, ...observed };
}

async function prepare() {
  requireHost();
  await ensureParent();
  const info = await lockInfo();
  const published = join(TARGET, info.key);
  let alreadyPublished = false;
  try {
    await lstat(published);
    alreadyPublished = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Never overwrite a previously published store, even if verification fails.
  if (alreadyPublished) return verify();
  const lock = published + '.lock';
  await mkdir(lock, { mode: 0o700 }); // Exclusive, no automatic stale-lock recovery.
  let stage;
  try {
    stage = await mkdtemp(join(LOCAL, '.patch-check-pnpm-'));
  } catch (error) {
    await rmdir(lock);
    throw error;
  }
  const workspace = join(stage, 'workspace');
  const store = join(stage, 'store');
  const home = join(stage, 'home');
  let publishedStore = false;
  try {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mirrorManifests(workspace);
    const pnpmVersion = await runPnpm(['--version'], workspace, home, 20_000);
    if (pnpmVersion !== POLICY.pnpmVersion)
      throw new Error('pnpm binary version differs from lockfile toolchain');
    const options = [
      '--store-dir=' + store,
      '--ignore-pnpmfile',
      '--ignore-scripts',
      '--frozen-lockfile',
      '--registry=https://registry.npmjs.org/',
      '--userconfig=' + join(workspace, '.npmrc'),
      '--reporter=silent',
    ];
    const filters = ['--filter', '@gym-dev-hub/api', '--filter', '@gym-dev-hub/web'];
    // Trusted-host provisioning is the ONLY network-eligible step.
    await runPnpm(['fetch', ...options, ...filters], workspace, home);
    // Probe complete dependency closure and lockfile SRI with zero network.
    await runPnpm(
      ['install', ...options, ...filters, '--offline', '--config.package-import-method=copy'],
      workspace,
      home,
    );
    const inventory = await inspectStore(store);
    const snapshot = {
      protocol: 1,
      storeKey: info.key,
      lockSha256: info.lockSha256,
      storeDigest: inventory.digest,
      pnpmVersion: POLICY.pnpmVersion,
      platform: 'linux-x64',
      files: inventory.files,
      bytes: inventory.bytes,
    };
    // Persist only after the inventory is validated. The parent is ignored
    // local state; never mutate the shared global pnpm content-addressed store.
    await rename(store, published);
    publishedStore = true;
    await writeFile(published + '.json', JSON.stringify(snapshot, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return await verify();
  } catch (error) {
    if (publishedStore)
      throw new Error(
        'Provisioning interrupted after store publish; inspect local snapshot before retrying',
        { cause: error },
      );
    throw error;
  } finally {
    // Exclusive mkdtemp directory, owned by this invocation; published store
    // is moved out first. Never operate recursively on a caller-provided path.
    await rm(stage, { recursive: true, force: true });
    await rmdir(lock);
  }
}

export async function run(args) {
  if (args.length !== 1 || !['--prepare', '--verify'].includes(args[0])) {
    throw new Error('Use exactly --prepare or --verify');
  }
  return args[0] === '--prepare' ? prepare() : verify();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify({ status: 'verified', ...result })),
    (error) => {
      console.error('Pinned patch-check store failed:', error.message);
      process.exitCode = 1;
    },
  );
}
