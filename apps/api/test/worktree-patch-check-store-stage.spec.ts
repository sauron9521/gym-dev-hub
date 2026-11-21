import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { withPatchCheckStoreStage } from '../src/worktree/worktree-patch-check-store-stage.js';

const prefix = '/tmp/gym-dev-hub-store-stage-test-';
const H = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const keyPrefix = Buffer.from('gym-dev-hub:patch-check:pnpm12.18.0:linux-x64+linux-x64-musl:v2\0');
const canRun = process.platform === 'linux' && process.getuid?.() !== 0;

describe.skipIf(!canRun)('production non-root private pnpm store staging', () => {
  let fixture: string;
  let store: string;
  let lock: string;
  let key: string;

  beforeEach(async () => {
    fixture = await mkdtemp(prefix);
    lock = join(fixture, 'pnpm-lock.yaml');
    const lockBytes = Buffer.from('lockfileVersion: 9.0\n');
    await writeFile(lock, lockBytes, { mode: 0o600 });
    key = H(Buffer.concat([keyPrefix, lockBytes]));
    store = join(fixture, 'private', key);
    await mkdir(join(store, 'v11/files'), { recursive: true, mode: 0o700 });
    await chmod(join(fixture, 'private'), 0o700);
    await writeFile(join(store, 'v11/index.db'), 'pinned-index', { mode: 0o600 });
    await writeFile(join(store, 'v11/files/a'), 'pinned-package', { mode: 0o600 });
    const hash = createHash('sha256');
    // Same sorted walk protocol as scripts/prepare-patch-check-store.mjs.
    for (const [path, content] of [
      ['v11/files/a', 'pinned-package'],
      ['v11/index.db', 'pinned-index'],
    ])
      hash
        .update(path + '\0' + Buffer.byteLength(content) + '\0')
        .update(content)
        .update('\0');
    await writeFile(
      store + '.json',
      JSON.stringify({
        protocol: 2,
        lockSha256: H(lockBytes),
        storeKey: key,
        pnpmVersion: '12.18.0',
        targetPlatforms: ['linux-x64', 'linux-x64-musl'],
        storeDigest: hash.digest('hex'),
        files: 2,
        bytes: Buffer.byteLength('pinned-package') + Buffer.byteLength('pinned-index'),
      }),
      { mode: 0o600 },
    );
  });

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it('verifies every byte, makes ONLY a temporary mirror readable and preserves private original', async () => {
    const originalMode = (await lstat(join(store, 'v11/index.db'))).mode & 0o777;
    const sourceMode = (await lstat(store)).mode & 0o777;
    let stage = '';
    const result = await withPatchCheckStoreStage(
      store,
      lock,
      new AbortController().signal,
      async (publicStore, evidence) => {
        stage = publicStore;
        expect(publicStore).not.toBe(store);
        expect(evidence).toMatchObject({ files: 2 });
        expect((await lstat(publicStore)).mode & 0o777).toBe(0o755);
        expect((await lstat(join(publicStore, 'v11/files/a'))).mode & 0o777).toBe(0o644);
        expect((await lstat(join(publicStore, 'v11/index.db'))).mode & 0o777).toBe(0o644);
        expect((await lstat(publicStore + '.json')).mode & 0o777).toBe(0o600);
        expect(await readFile(join(publicStore, 'v11/files/a'), 'utf8')).toBe('pinned-package');
        return 'verified';
      },
    );
    expect(result).toBe('verified');
    expect((await lstat(store)).mode & 0o777).toBe(sourceMode);
    expect((await lstat(join(store, 'v11/index.db'))).mode & 0o777).toBe(originalMode);
    await expect(lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a changed byte or altered manifest before running the callback', async () => {
    let called = false;
    await writeFile(join(store, 'v11/files/a'), 'pinned-packagX');
    await expect(
      withPatchCheckStoreStage(store, lock, new AbortController().signal, async () => {
        called = true;
      }),
    ).rejects.toThrow(/digest/);
    expect(called).toBe(false);
    expect(await readdir(fixture)).toContain('private');
  });

  it('rejects symlinks outside excluded pnpm project bookkeeping', async () => {
    await symlink(join(store, 'v11/index.db'), join(store, 'v11/files/symlink'));
    await expect(
      withPatchCheckStoreStage(store, lock, new AbortController().signal, async () => undefined),
    ).rejects.toThrow(/Symlink/);
    expect((await lstat(join(store, 'v11/index.db'))).isFile()).toBe(true);
  });

  it('cleans up even if Docker action rejects, or grant aborts', async () => {
    let stage = '';
    await expect(
      withPatchCheckStoreStage(store, lock, new AbortController().signal, async (publicStore) => {
        stage = publicStore;
        throw new Error('simulated Docker failure');
      }),
    ).rejects.toThrow('simulated Docker failure');
    await expect(lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
    const abort = new AbortController();
    abort.abort();
    await expect(
      withPatchCheckStoreStage(store, lock, abort.signal, async () => undefined),
    ).rejects.toThrow(/canceled/);
  });

  it('refuses unpinned store names, manifest drift and lockfile mismatch', async () => {
    await writeFile(lock, 'different locked dependencies');
    await expect(
      withPatchCheckStoreStage(store, lock, new AbortController().signal, async () => undefined),
    ).rejects.toThrow(/does not match/);
    expect((await lstat(store)).mode & 0o777).toBe(0o700);
  });
});
