/**
 * CI-only preflight for FUTURE task execution. Checks exact full-source snapshot,
 * 2 read-only bind mounts, 2 independent private tmpfs mounts, and scratch
 * read/write isolation. It NEVER evaluates target source, runs pnpm or scripts.
 * Unreachable from the ordinary runner protocol and NestJS API.
 */
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, open, readFile, readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

const COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const MANIFEST = 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';
const TMPFS_MAGIC = 0x01021994;

const expectedMounts = Object.freeze({
  '/source': { kind: 'bind', options: ['ro'] },
  '/manifest': { kind: 'bind', options: ['ro'] },
  '/workspace': { kind: 'tmpfs', options: ['rw', 'noexec', 'nosuid', 'nodev'] },
  '/results': { kind: 'tmpfs', options: ['rw', 'noexec', 'nosuid', 'nodev'] },
});

function activeMounts(content) {
  const mounted = new Map();
  for (const line of content.split('\n')) {
    if (!line) continue;
    const [head, tail] = line.split(' - ');
    if (!head || !tail) throw new Error('Malformed Linux mount information');
    const left = head.split(' ');
    const right = tail.split(' ');
    if (left.length < 6 || right.length < 3) throw new Error('Incomplete mount information');
    const path = left[4];
    if (path in expectedMounts) {
      mounted.set(path, {
        device: left[2],
        options: left[5].split(','),
        type: right[0],
      });
    }
  }
  return mounted;
}

async function checkMounts() {
  const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
  const mounted = activeMounts(mountInfo);
  for (const [path, expectation] of Object.entries(expectedMounts)) {
    const current = mounted.get(path);
    if (!current || expectation.options.some((opt) => !current.options.includes(opt))) {
      throw new Error('Unsafe or missing Docker mount: ' + path);
    }
    if (expectation.kind === 'tmpfs' && current.type !== 'tmpfs') {
      throw new Error('Writable area is not a private tmpfs');
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe mountpoint');
    if (expectation.kind === 'tmpfs') {
      const fs = await statfs(path);
      if (fs.type !== TMPFS_MAGIC) throw new Error('Writable area is not memory-backed');
    }
  }
  const workspace = await stat('/workspace');
  const results = await stat('/results');
  if (workspace.dev === results.dev) {
    throw new Error('Outputs and dependencies must use independent tmpfs volumes');
  }
}

async function verifyPinnedSource() {
  const proc = spawnSync('/usr/bin/node', ['/opt/gym-dev-hub/full-source-audit.mjs'], {
    shell: false,
    timeout: 45_000,
    encoding: 'utf8',
    maxBuffer: 16_384,
    cwd: '/opt/gym-dev-hub',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp',
      TMPDIR: '/tmp',
      CI: 'true',
    },
  });
  if (proc.status !== 0 || proc.error || proc.signal) {
    throw new Error('Pinned full-source manifest or Git blobs did not verify');
  }
  let summary;
  try {
    summary = JSON.parse(proc.stdout.trim());
  } catch {
    throw new Error('Malformed pinned source audit response');
  }
  if (
    summary.protocol !== 1 ||
    summary.event !== 'immutable-full-source-snapshot-verified' ||
    summary.sourceCommit !== COMMIT ||
    summary.sourceTree !== TREE ||
    summary.manifestSha256 !== MANIFEST ||
    summary.trackedFiles !== 1258 ||
    summary.sourceBytes !== 6241392 ||
    summary.sourceCodeExecuted !== false ||
    summary.arbitraryExecutionEnabled !== false
  ) {
    throw new Error('Pinned source identity or audit policy mismatch');
  }
}

async function assertEmpty(path) {
  if ((await readdir(path)).length !== 0) {
    throw new Error('Writable tmpfs is not empty: leaked state across runs');
  }
}

async function exclusiveWrite(path, bytes) {
  const fd = await open(path, 'wx', 0o600);
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
  const check = await readFile(path);
  if (!check.equals(bytes)) throw new Error('Scratch file readback mismatch');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== bytes.length) {
    throw new Error('Scratch file has unsafe properties');
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Arguments not supported');
  await checkMounts();
  await assertEmpty('/workspace');
  await assertEmpty('/results');

  // Everything under /source and /manifest is read-only; the child validator
  // rehashes each Git blob in the same container before scratch setup.
  await verifyPinnedSource();
  for (const path of [
    '/workspace/dependencies',
    '/workspace/cache',
    '/workspace/generated',
    '/results/reports',
  ]) {
    await mkdir(path, { recursive: false, mode: 0o700 });
  }

  const dependencyMarker = Buffer.from('Private package overlay, no packages installed\n');
  const cacheMarker = Buffer.from('Private temporary cache, no network requests\n');
  const generatedMarker = Buffer.from('Generated files may only be written to tmpfs\n');
  await exclusiveWrite('/workspace/dependencies/provisioning-proof.txt', dependencyMarker);
  await exclusiveWrite('/workspace/cache/cache-proof.txt', cacheMarker);
  await exclusiveWrite('/workspace/generated/metadata-proof.txt', generatedMarker);

  const output = {
    protocol: 1,
    event: 'private-writable-overlay-preflight-passed',
    sourceCommit: COMMIT,
    sourceTree: TREE,
    sourceManifestSha256: MANIFEST,
    trackedSourceFiles: 1258,
    readOnlyBindMounts: ['/manifest', '/source'],
    privateTmpfsMounts: ['/results', '/workspace'],
    verifiedPrivateScratch: ['dependencies', 'cache', 'generated', 'reports'],
    sourceCodeExecuted: false,
    projectScriptsExecuted: false,
    packagesInstalled: false,
    runtimeNetworkEnabled: false,
    taskExecutionEnabled: false,
    taskGrantConsumed: false,
    futureRecipe: 'API_TYPECHECK',
  };
  const reportBytes = Buffer.from(JSON.stringify(output) + '\n');
  await exclusiveWrite('/results/reports/preflight.jsonl', reportBytes);

  // This is a CI-only smoke: report lives on a private tmpfs, and disappears
  // with the container. No output or source is written to a host bind mount.
  process.stdout.write(JSON.stringify(output) + '\n');
}

main().catch(() => {
  process.stderr.write('Private overlay preflight rejected: unsafe mount, source or output state\n');
  process.exitCode = 1;
});
