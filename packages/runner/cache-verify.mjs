/**
 * CI-only fixed fixture cache proof, NOT available through runner.mjs or API.
 * Never extracts archives or executes package scripts.
 * Manifest-provided digests are not trusted without an independent pinned SRI.
 */
import { createHash } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const INPUT = '/input';
const CACHE = '/cache';
const ARCHIVE = 'cache-fixture.tgz.b64';
const MANIFEST = 'cache-manifest.json';
const PACKAGE = '@devhub/cache-fixture@1.0.0';
const SIZE = 215;
const EXPECTED_SRI =
  'sha512-vy8Bx06sU5x0mIZgF7KQALH13zx2KincLdBFCGlfr0xgncG3pqd8aEH9gLDlHN3Y8gR4bXQki5VUWhoqWZBJRA==';
const MAX_INPUT_BYTES = 8192;

async function regularFile(name) {
  const path = join(INPUT, name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_INPUT_BYTES) {
    throw new Error('Unsafe fixture file');
  }
  const data = await readFile(path);
  if (data.length !== stat.size) throw new Error('Fixture changed during read');
  return data;
}

function parseManifest(bytes) {
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(',') !== 'archive,integrity,package,sizeBytes' ||
    manifest.archive !== ARCHIVE ||
    manifest.package !== PACKAGE ||
    manifest.sizeBytes !== SIZE ||
    manifest.integrity !== EXPECTED_SRI
  ) {
    throw new Error('Manifest is not the pinned reviewed fixture');
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No user-provided arguments accepted');
  const cacheStat = await lstat(CACHE);
  const inputStat = await lstat(INPUT);
  if (
    !cacheStat.isDirectory() ||
    cacheStat.isSymbolicLink() ||
    !inputStat.isDirectory() ||
    inputStat.isSymbolicLink()
  ) {
    throw new Error('Unsafe input or cache directory');
  }

  parseManifest(await regularFile(MANIFEST));
  const text = (await regularFile(ARCHIVE)).toString('ascii').trimEnd();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('Invalid fixture encoding');
  const data = Buffer.from(text, 'base64');
  if (
    data.length !== SIZE ||
    data.toString('base64') !== text ||
    data[0] !== 0x1f ||
    data[1] !== 0x8b ||
    data[2] !== 0x08
  ) {
    throw new Error('Unexpected or malformed compressed fixture');
  }

  const digest = createHash('sha512').update(data).digest();
  const sri = 'sha512-' + digest.toString('base64');
  if (sri !== EXPECTED_SRI) throw new Error('Archive digest differs from trusted pin');
  const key = 'sha512-' + digest.toString('hex');
  const target = join(CACHE, key + '.tgz');

  // Exclusive creation prevents overwriting another cache entry. The cache
  // lives only in ephemeral tmpfs. Never write into source or a shared store.
  const file = await open(target, 'wx', 0o600);
  let complete = false;
  try {
    await file.writeFile(data);
    await file.sync();
    await file.close();
    const cached = await readFile(target);
    if (cached.length !== SIZE || !cached.equals(data)) {
      throw new Error('Cached bytes differ from verified source');
    }
    complete = true;
  } finally {
    await file.close();
    if (!complete) await unlink(target).catch(() => undefined);
  }

  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'integrity-cache-staged',
      executionEnabled: false,
      package: PACKAGE,
      integrity: sri,
      cacheKey: key,
      cachedBytes: data.length,
      archiveExtracted: false,
      lifecycleScriptsExecuted: false,
      dependencyInstallExecuted: false,
    }) + '\n',
  );
}

main().catch(() => {
  process.stderr.write('Pinned dependency cache fixture rejected\n');
  process.exitCode = 1;
});
