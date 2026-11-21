import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePinArgs, replaceOnlyPinnedStore, runOwnerPin } from './launch-owner-pin-store.mjs';
import { storeKey } from './prepare-patch-check-store.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const PRIVATE_MARKER = 'PRIVATE_MUST_NOT_APPEAR_IN_OUTPUT';
const digest = (data) => createHash('sha256').update(data).digest('hex');

function git(dir, ...args) {
  const p = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: 12_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  assert.equal(p.status, 0, 'Fixture Git setup');
  return p.stdout.trim();
}
async function fixture() {
  const checkout = await mkdtemp(join(tmpdir(), 'hub-pin-owner-'));
  const backupParent = await mkdtemp(join(tmpdir(), 'hub-pin-private-'));
  await chmod(backupParent, 0o700);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fixture');
  git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
  await mkdir(join(checkout, 'apps/api'), { recursive: true });
  await writeFile(join(checkout, 'pnpm-lock.yaml'), 'lockfile-version-test\n');
  await writeFile(join(checkout, '.gitignore'), 'apps/api/.env\napps/api/.local/\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'baseline');
  const expectedMain = git(checkout, 'rev-parse', 'HEAD');
  const envPath = join(checkout, 'apps/api/.env');
  const original = Buffer.from(
    '# keep this comment\nSECRET_FOR_TESTS=' +
      PRIVATE_MARKER +
      '\n' +
      'DEV_HUB_PATCH_CHECK_PNPM_STORE=/old/private/store\nOTHER=kept\n',
  );
  await writeFile(envPath, original, { mode: 0o600 });
  await chmod(envPath, 0o600);
  const lock = await readFile(join(checkout, 'pnpm-lock.yaml'));
  const expectedStore = join(checkout, 'apps/api/.local/patch-check-pnpm-stores', storeKey(lock));
  const verify = async (path, bytes) => {
    assert.equal(path, expectedStore);
    assert.deepEqual(bytes, lock);
    return { verified: true };
  };
  const stopped = async () => ({
    status: 'no-known-operator-processes-at-scan-time',
    totalBlocking: 0,
  });
  const options = {
    checkout,
    expectedMain,
    verify,
    scan: stopped,
    portProbe: async () => true,
    ports: [3100, 3101],
  };
  return {
    ...options,
    backupParent,
    envPath,
    expectedStore,
    original,
    cleanup: async () => {
      await rm(checkout, { recursive: true, force: true });
      await rm(backupParent, { recursive: true, force: true });
    },
  };
}
function argsFor(f, mode, envSha) {
  const out = [mode, '--expected-main=' + f.expectedMain, '--operator-checkout=' + f.checkout];
  if (envSha) out.push('--expected-env-sha256=' + envSha, '--backup-parent=' + f.backupParent);
  return out;
}

test('exact CLI is required and read-only has no mutation flags', () => {
  assert.deepEqual(
    parsePinArgs(['--check-only', '--expected-main=' + SHA, '--operator-checkout=/tmp/hub']),
    {
      mode: '--check-only',
      expectedMain: SHA,
      checkout: '/tmp/hub',
      expectedEnvSha: null,
      backupParent: null,
    },
  );
  for (const args of [
    [],
    ['--apply'],
    ['--check-only', '--expected-main=' + SHA, '--operator-checkout=./hub'],
    ['--check-only', '--expected-main=' + SHA, '--operator-checkout=/tmp/hub', '--apply'],
    ['--confirm-private-env-pin', '--expected-main=' + SHA, '--operator-checkout=/tmp/hub'],
    [
      '--confirm-private-env-pin',
      '--expected-main=' + SHA,
      '--operator-checkout=/tmp/hub',
      '--expected-env-sha256=' + DIGEST,
      '--backup-parent=/tmp/../unsafe',
    ],
    [
      '--confirm-private-env-pin',
      '--expected-main=' + SHA,
      '--operator-checkout=/tmp/hub',
      '--expected-env-sha256=bad',
      '--backup-parent=/tmp/backup',
    ],
    [
      '--confirm-private-env-pin',
      '--expected-main=nope',
      '--operator-checkout=/tmp/hub',
      '--expected-env-sha256=' + DIGEST,
      '--backup-parent=/tmp/backup',
    ],
  ])
    assert.throws(() => parsePinArgs(args));
});

test('replaces only exact pinned-store key, preserves other secret bytes, CRLF and trailing newline', () => {
  const target = '/trusted/new/private/key';
  const before = Buffer.from(
    'SECRET=' + PRIVATE_MARKER + '\r\nDEV_HUB_PATCH_CHECK_PNPM_STORE=/old/path\r\n# comment\r\n',
  );
  const result = replaceOnlyPinnedStore(before, target);
  assert.equal(result.changed, true);
  assert.deepEqual(
    result.updated,
    Buffer.from(
      'SECRET=' +
        PRIVATE_MARKER +
        '\r\nDEV_HUB_PATCH_CHECK_PNPM_STORE=' +
        target +
        '\r\n# comment\r\n',
    ),
  );
  assert.equal(replaceOnlyPinnedStore(result.updated, target).changed, false);
  for (const unsafe of [
    'DEV_HUB_PATCH_CHECK_PNPM_STORE=/old\nDEV_HUB_PATCH_CHECK_PNPM_STORE=/dup\n',
    'OTHER=x\n',
    'DEV_HUB_PATCH_CHECK_PNPM_STORE=\n',
    'DEV_HUB_PATCH_CHECK_PNPM_STORE=/old\r\nOTHER=yes\n',
    'DEV_HUB_PATCH_CHECK_PNPM_STORE=/old\nexport DEV_HUB_PATCH_CHECK_PNPM_STORE=/dup\n',
    'DEV_HUB_PATCH_CHECK_PNPM_STORE=/old\n  DEV_HUB_PATCH_CHECK_PNPM_STORE=/dup\n',
  ])
    assert.throws(() => replaceOnlyPinnedStore(Buffer.from(unsafe), target));
});

test('read-only verifies current lockfile store and reports only hash/status, never secrets', async () => {
  const f = await fixture();
  try {
    const r = await runOwnerPin({ ...f, mode: '--check-only' });
    assert.equal(r.status, 'verified-store-pin-update-required');
    assert.equal(r.targetStorePath, f.expectedStore);
    assert.equal(r.targetStoreContentVerified, true);
    assert.equal(r.envSha256, digest(f.original));
    assert.equal(r.privateEnvChanged, false);
    assert.equal(r.runtimeRestarted, false);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(PRIVATE_MARKER));
    assert.deepEqual(await readFile(f.envPath), f.original);
  } finally {
    await f.cleanup();
  }
});

test('owner-confirmed update preserves private original and only swaps store pin, no restart', async () => {
  const f = await fixture();
  try {
    const pre = await runOwnerPin({ ...f, mode: '--check-only' });
    const result = await runOwnerPin({
      ...f,
      mode: '--confirm-private-env-pin',
      expectedEnvSha: pre.envSha256,
    });
    assert.equal(result.status, 'private-pinned-store-config-updated-restart-required');
    assert.equal(result.runtimeRestarted, false);
    assert.equal(result.auditChanged, false);
    assert.equal(result.privateEnvChanged, true);
    const actual = await readFile(f.envPath);
    assert.equal(
      actual.toString('utf8'),
      f.original.toString('utf8').replace('/old/private/store', f.expectedStore),
    );
    assert.equal((await lstat(f.envPath)).mode & 0o077, 0);
    const backup = await readFile(join(result.backupDirectory, 'env.before'));
    assert.deepEqual(backup, f.original);
    assert.equal((await lstat(result.backupDirectory)).mode & 0o077, 0);
    assert.equal((await lstat(join(result.backupDirectory, 'env.before'))).mode & 0o077, 0);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.expectedMain);
    const again = await runOwnerPin({ ...f, mode: '--check-only' });
    assert.equal(again.status, 'verified-store-already-pinned');
    const noop = await runOwnerPin({
      ...f,
      mode: '--confirm-private-env-pin',
      expectedEnvSha: again.envSha256,
    });
    assert.equal(noop.status, 'already-pinned-no-write');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(PRIVATE_MARKER));
  } finally {
    await f.cleanup();
  }
});

test('active runtime denies change even with valid exact env SHA; no backup created', async () => {
  const f = await fixture();
  try {
    const report = await runOwnerPin({ ...f, mode: '--check-only' });
    await assert.rejects(
      runOwnerPin({
        ...f,
        mode: '--confirm-private-env-pin',
        expectedEnvSha: report.envSha256,
        portProbe: async () => false,
      }),
    );
    assert.deepEqual(await readFile(f.envPath), f.original);
  } finally {
    await f.cleanup();
  }
});

test('stale expected SHA, foreign origin, symlink env or unsafe private parent are rejected', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runOwnerPin({
        ...f,
        mode: '--confirm-private-env-pin',
        expectedEnvSha: DIGEST,
      }),
    );
    await chmod(f.backupParent, 0o755);
    await assert.rejects(
      runOwnerPin({
        ...f,
        mode: '--confirm-private-env-pin',
        expectedEnvSha: digest(f.original),
      }),
    );
    await chmod(f.backupParent, 0o700);
    const altered = await readFile(f.envPath);
    await rm(f.envPath);
    await symlink(join(f.checkout, 'pnpm-lock.yaml'), f.envPath);
    await assert.rejects(runOwnerPin({ ...f, mode: '--check-only' }));
    await rm(f.envPath);
    await writeFile(f.envPath, altered, { mode: 0o600 });
    await chmod(f.envPath, 0o600);
    git(f.checkout, 'remote', 'set-url', 'origin', 'git@github.com:other/fork.git');
    await assert.rejects(runOwnerPin({ ...f, mode: '--check-only' }));
  } finally {
    await f.cleanup();
  }
});

test('missing or unverified current store refuses any owner config change', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runOwnerPin({
        ...f,
        mode: '--confirm-private-env-pin',
        expectedEnvSha: digest(f.original),
        verify: async () => ({ reason: 'pinned-store-content-mismatch' }),
      }),
    );
    assert.deepEqual(await readFile(f.envPath), f.original);
  } finally {
    await f.cleanup();
  }
});

test('linked Git worktree cannot be targeted as the owner primary env checkout', async () => {
  const f = await fixture();
  const linked = await mkdtemp(join(tmpdir(), 'hub-pin-linked-'));
  try {
    await rm(linked, { recursive: true });
    git(f.checkout, 'worktree', 'add', '-q', '-b', 'fixture-linked', linked, f.expectedMain);
    await assert.rejects(
      runOwnerPin({
        ...f,
        mode: '--check-only',
        checkout: linked,
      }),
    );
    assert.deepEqual(await readFile(f.envPath), f.original);
  } finally {
    git(f.checkout, 'worktree', 'remove', '--force', linked);
    await f.cleanup();
  }
});
