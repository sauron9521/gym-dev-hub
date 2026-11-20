/**
 * CI-only read-only audit of a reviewed, immutable Gym Platform Git snapshot.
 * No package manager, Git subprocess, Docker, remote fetch, or code execution.
 * The source checkout is intentionally separate from gym-dev-hub's working tree.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TARGET = Object.freeze({
  repository: 'sauron9521/gym-platform',
  commit: '73b636f5d064c7f24b43607e0c8411e9161f8986',
  blobs: Object.freeze({
    'pnpm-lock.yaml': '994456e853beaa556ab5a0d5ee3533b8f7db5682',
    'pnpm-workspace.yaml': '0af4a0308ad0b25ea1813badb71b09b0256b6513',
    'package.json': '4fa06500522abaa2fc809d022e3c4f74267a8d67',
    'apps/api/package.json': '314142f3577c0620ff3402b7de3d25ef9702a5f4',
    'apps/web/package.json': '4bba19980d8d53075cac8774e1fd6de7e2720dbf',
  }),
});

const ALLOWED_BUILDS = Object.freeze({
  '@prisma/engines': true,
  prisma: true,
  bcrypt: true,
  esbuild: true,
  '@swc/core': true,
  '@parcel/watcher': false,
  '@scarf/scarf': false,
});
const EXPECTED_IGNORES = ['GHSA-fc5q-39xc-vjpf'];
const MAX_FILE_BYTES = 1_500_000;

export function gitBlobSha(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
}

export function auditLockText(source) {
  if (typeof source !== 'string' || source.length > MAX_FILE_BYTES) {
    throw new Error('Invalid or oversized pnpm lockfile');
  }
  const lines = source.split('\n');
  const separators = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '---') separators.push(i);
  }
  // pnpm 12 lockfiles may contain two YAML documents: the package manager's
  // dependency graph and the application's dependency graph. Audit BOTH.
  if (separators.length !== 2 || separators[0] !== 0 || separators[1] < 15) {
    throw new Error('Expected both pnpm 12 lockfile YAML documents');
  }
  const documents = [
    lines.slice(separators[0], separators[1]),
    lines.slice(separators[1]),
  ];
  const counts = [];
  const seenGlobal = new Set();
  for (const [documentIndex, document] of documents.entries()) {
    if (document.filter((line) => line === "lockfileVersion: '9.0'").length !== 1) {
      throw new Error('Unsupported or duplicated lockfile version');
    }
    const start = document.indexOf('packages:');
    const end = document.indexOf('snapshots:');
    if (start < 0 || end <= start || document.indexOf('packages:', start + 1) !== -1) {
      throw new Error('Missing or duplicated package and snapshot sections');
    }
    let current = null;
    let currentResolved = false;
    const seen = new Set();
    let count = 0;
    let binaries = 0;
    function finish() {
      if (current !== null && !currentResolved) {
        throw new Error('Package missing SHA-512 integrity: ' + current);
      }
    }
    for (const line of document.slice(start + 1, end)) {
      const entry = /^  (\S.*):$/.exec(line);
      if (entry) {
        finish();
        current = entry[1];
        if (seen.has(current) || seenGlobal.has(current)) {
          throw new Error('Duplicate package identifier: ' + current);
        }
        seen.add(current);
        seenGlobal.add(current);
        currentResolved = false;
        count++;
        continue;
      }
      if (/^    resolution:/.test(line)) {
        if (!current || currentResolved) throw new Error('Invalid resolution position');
        const match = /^    resolution: \{integrity: sha512-([A-Za-z0-9+/]{86}==)\}$/.exec(
          line,
        );
        if (!match) throw new Error('Unpinned or non-SHA512 package resolution: ' + current);
        const digest = Buffer.from(match[1], 'base64');
        if (digest.length !== 64 || digest.toString('base64') !== match[1]) {
          throw new Error('Malformed SHA-512 resolution digest: ' + current);
        }
        currentResolved = true;
        continue;
      }
      if (/^    hasBin: true$/.test(line)) binaries++;
      if (/^    (?:tarball|id|registry):/.test(line)) {
        throw new Error('Unexpected custom package source');
      }
    }
    finish();
    if (!count) throw new Error('Package section is empty');
    for (const line of document.slice(0, start)) {
      if (/^        (?:version|specifier):\s+(?:file:|git\+|git:|https?:|tarball:)/.test(line)) {
        throw new Error('Unsupported importer source protocol');
      }
    }
    counts.push({ yamlDocument: documentIndex + 1, packageCount: count, sha512Pins: count, packagesWithBins: binaries });
  }
  return {
    yamlDocuments: 2,
    packageCount: counts.reduce((sum, item) => sum + item.packageCount, 0),
    sha512Pins: counts.reduce((sum, item) => sum + item.sha512Pins, 0),
    documents: counts,
  };
}

export function auditWorkspaceText(source) {
  if (typeof source !== 'string' || source.length > 100_000) {
    throw new Error('Invalid workspace policy');
  }
  if (!source.includes("nodeLinker: hoisted")) throw new Error('Unexpected node linker');
  const lines = source.split('\n');
  const start = lines.indexOf('allowBuilds:');
  if (start < 0 || lines.indexOf('allowBuilds:', start + 1) !== -1) {
    throw new Error('Missing or repeated build allowlist');
  }
  const builds = {};
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith(' ')) break;
    if (!line.trim()) continue;
    const match = /^  (?:'([^']+)'|([@A-Za-z0-9._/-]+)): (true|false)$/.exec(line);
    if (!match) throw new Error('Unrecognized build policy entry');
    const key = match[1] ?? match[2];
    if (Object.hasOwn(builds, key)) throw new Error('Duplicated build policy entry');
    builds[key] = match[3] === 'true';
  }
  const expectedKeys = Object.keys(ALLOWED_BUILDS).sort();
  if (JSON.stringify(Object.keys(builds).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('Unexpected change in native build policy');
  }
  for (const key of expectedKeys) {
    if (builds[key] !== ALLOWED_BUILDS[key]) {
      throw new Error('Unexpected change to package build allowance: ' + key);
    }
  }
  const ignores = lines
    .filter((line) => /^    - GHSA-[a-z0-9-]+$/.test(line))
    .map((line) => line.trim().slice(2));
  if (JSON.stringify(ignores) !== JSON.stringify(EXPECTED_IGNORES)) {
    throw new Error('Unexpected security audit suppression');
  }
  return {
    buildScriptsAllowed: expectedKeys.filter((key) => builds[key]),
    buildScriptsDenied: expectedKeys.filter((key) => !builds[key]),
    auditAdvisoryExceptions: ignores,
    scriptsActuallyExecuted: false,
  };
}

async function readPinned(root, file, sha) {
  let cursor = root;
  for (const segment of file.split('/').slice(0, -1)) {
    cursor = join(cursor, segment);
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Unexpected source directory type');
    }
  }
  const path = join(root, file);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
    throw new Error('Missing or unsafe pinned Git file: ' + file);
  }
  const bytes = await readFile(path);
  if (bytes.length !== stat.size || gitBlobSha(bytes) !== sha) {
    throw new Error('Pinned Git blob changed: ' + file);
  }
  return bytes;
}

export async function auditPinnedCheckout(root) {
  const actualRoot = resolve(root);
  const rootStat = await lstat(actualRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Invalid repository checkout');
  }
  const files = {};
  for (const [path, sha] of Object.entries(TARGET.blobs)) {
    files[path] = await readPinned(actualRoot, path, sha);
  }
  const packageJson = JSON.parse(files['package.json'].toString('utf8'));
  const api = JSON.parse(files['apps/api/package.json'].toString('utf8'));
  const web = JSON.parse(files['apps/web/package.json'].toString('utf8'));
  if (
    packageJson.name !== 'gym-platform' ||
    packageJson.packageManager !== 'pnpm@12.18.0' ||
    api.name !== '@gym/api' ||
    web.name !== '@gym/web' ||
    [api, web].some((pkg) => !['lint', 'test', 'typecheck'].every((name) => typeof pkg.scripts?.[name] === 'string'))
  ) {
    throw new Error('Unexpected Gym Platform package metadata');
  }
  const lock = auditLockText(files['pnpm-lock.yaml'].toString('utf8'));
  const workspace = auditWorkspaceText(files['pnpm-workspace.yaml'].toString('utf8'));
  if (lock.packageCount < 1000 || lock.documents[1].packageCount < 1000) {
    throw new Error('Pinned monorepo lockfile is unexpectedly small');
  }
  return {
    status: 'verified-pinned-snapshot',
    repository: TARGET.repository,
    commit: TARGET.commit,
    filesVerifiedByGitBlob: Object.keys(TARGET.blobs).length,
    lockSha256: createHash('sha256').update(files['pnpm-lock.yaml']).digest('hex'),
    packageManager: packageJson.packageManager,
    lock,
    workspace,
    installExecuted: false,
    registryContacted: false,
    executionAuthorized: false,
    caveat: 'Static audit of one immutable Git snapshot, not a package security scan or a live-main approval',
  };
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '.audit/gym-platform') {
    throw new Error('Only fixed CI checkout path accepted');
  }
  const result = await auditPinnedCheckout(process.argv[2]);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(
      'Pinned dependency audit rejected: ' +
        (error instanceof Error ? error.message : 'unknown failure') +
        '\n',
    );
    process.exitCode = 1;
  });
}
