import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectStore,
  mirrorManifests,
  POLICY,
  run,
  storeKey,
} from './prepare-patch-check-store.mjs';

test('store fingerprint binds exact lock bytes and pinned toolchain', () => {
  assert.match(storeKey('lock-A'), /^[a-f0-9]{64}$/);
  assert.equal(storeKey('lock-A'), storeKey(Buffer.from('lock-A')));
  assert.notEqual(storeKey('lock-A'), storeKey('lock-B'));
  // A previous glibc-only store must never satisfy the updated musl recipe.
  const previous = createHash('sha256')
    .update('gym-dev-hub:patch-check:pnpm12.18.0:linux-x64:v1\0lock-A')
    .digest('hex');
  assert.notEqual(storeKey('lock-A'), previous);
  assert.deepEqual(POLICY.targetPlatforms, ['linux-x64', 'linux-x64-musl']);
  assert.equal(POLICY.maxFiles, 80_000);
  assert.equal(POLICY.maxBytes, 1_600 * 1024 * 1024);
});

test('metadata mirror fetches glibc and Alpine/musl dependencies without changing the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devhub-pnpm-multi-abi-'));
  const original = await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
  try {
    await mirrorManifests(root);
    const mirrored = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(mirrored, /supportedArchitectures:\n  - linux-x64\n  - linux-x64-musl/);
    assert.equal(mirrored.replace(/\nsupportedArchitectures:[\s\S]*$/, ''), original);
    assert.equal(
      await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'),
      original,
    );
    assert.match(
      await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'),
      /@rollup\/rollup-linux-x64-musl/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects unsupported manual operations', async () => {
  for (const args of [[], ['--delete'], ['--prepare', '--verify']]) {
    await assert.rejects(run(args), /Use exactly/);
  }
});

test('audits pinned v11 package store deterministically and never follows projects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devhub-pnpm-store-'));
  try {
    await mkdir(join(dir, 'v11/files/aa'), { recursive: true });
    await mkdir(join(dir, 'v11/projects'), { recursive: true });
    await writeFile(join(dir, 'v11/index.db'), 'index');
    await writeFile(join(dir, 'v11/files/aa/blob'), 'package contents');
    await symlink('/tmp/outside-project', join(dir, 'v11/projects/workspace-link'));
    const expected = await inspectStore(dir);
    assert.equal(expected.files, 2);
    assert.equal(expected.bytes, 5 + Buffer.byteLength('package contents'));
    assert.match(expected.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(await inspectStore(dir), expected);
    await writeFile(join(dir, 'v11/files/aa/blob'), 'tampered contents');
    assert.notEqual((await inspectStore(dir)).digest, expected.digest);
    await symlink('/etc/passwd', join(dir, 'v11/files/aa/host-link'));
    await assert.rejects(inspectStore(dir), /Symlink/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses incomplete store missing a nonempty v11 index or blob', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devhub-pnpm-store-incomplete-'));
  try {
    await mkdir(join(dir, 'v11/files/aa'), { recursive: true });
    await writeFile(join(dir, 'v11/files/aa/blob'), 'package');
    await assert.rejects(inspectStore(dir), /Incomplete/);
    await writeFile(join(dir, 'v11/index.db'), '');
    await assert.rejects(inspectStore(dir), /Incomplete/);
    await writeFile(join(dir, 'v11/index.db'), 'valid');
    assert.equal((await inspectStore(dir)).files, 2);
    await rm(join(dir, 'v11/files/aa/blob'));
    await assert.rejects(inspectStore(dir), /Incomplete/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
