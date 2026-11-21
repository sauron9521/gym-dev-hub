import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseBackupArgs,
  validateBackupEligibility,
  createOwnerBackup,
} from './launch-source-owner-backup.mjs';

const SHA = 'a'.repeat(40);
function git(root, ...args) {
  const p = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8',
    timeout: 12000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  assert.equal(p.status, 0, 'Fixture git operation failed');
  return p.stdout.trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hub-owner-backup-source-'));
  const parent = await mkdtemp(join(tmpdir(), 'hub-owner-backup-private-'));
  await chmod(parent, 0o700);
  git(root, 'init', '-b', 'main', '-q');
  git(root, 'config', 'user.name', 'Fixture Operator');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'remote', 'add', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
  await mkdir(join(root, 'apps', 'web'), { recursive: true });
  await writeFile(join(root, 'turbo.json'), '{"original":true}\n');
  await writeFile(join(root, 'apps/web/next-env.d.ts'), '// original typed source\n');
  await writeFile(join(root, 'README.md'), 'public trusted source\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial', '-q');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'future', '-q');
  await writeFile(join(root, 'docs.md'), 'upstream new content\n');
  git(root, 'add', 'docs.md');
  git(root, 'commit', '-m', 'future changes', '-q');
  const expectedMain = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', 'main', '-q');
  await writeFile(join(root, 'turbo.json'), '{"local":true}\n');
  await writeFile(join(root, 'apps/web/next-env.d.ts'), '// local node types\n');
  await mkdir(join(root, '.worktrees'));
  await writeFile(join(root, '.worktrees', 'preserve.txt'), 'keep me\n');
  await mkdir(join(root, 'apps', 'api'), { recursive: true });
  await writeFile(join(root, 'apps/api/.env'), 'PRIVATE_KEY_DO_NOT_READ=real-private-data\n');
  return { root, parent, head, expectedMain };
}
async function cleanup({ root, parent }) {
  await rm(root, { recursive: true, force: true });
  await rm(parent, { recursive: true, force: true });
}
const digest = (data) => createHash('sha256').update(data).digest('hex');

test('requires exact, conscious copy-only confirmation, canonical absolute paths, pinned SHA', () => {
  assert.deepEqual(
    parseBackupArgs([
      '--confirm-copy-only',
      '--expected-main=' + SHA,
      '--operator-checkout=/tmp/trusted-source',
      '--backup-parent=/tmp/private-destination',
    ]),
    { expectedMain: SHA, checkout: '/tmp/trusted-source', parent: '/tmp/private-destination' },
  );
  for (const argv of [
    [],
    ['--confirm-copy-only', '--expected-main=' + SHA, '--operator-checkout=/tmp/source'],
    [
      '--confirm-reset',
      '--expected-main=' + SHA,
      '--operator-checkout=/tmp/source',
      '--backup-parent=/tmp/backup',
    ],
    [
      '--confirm-copy-only',
      '--expected-main=' + 'x'.repeat(40),
      '--operator-checkout=/tmp/source',
      '--backup-parent=/tmp/backup',
    ],
    [
      '--confirm-copy-only',
      '--expected-main=' + SHA,
      '--operator-checkout=./relative',
      '--backup-parent=/tmp/backup',
    ],
    [
      '--confirm-copy-only',
      '--expected-main=' + SHA,
      '--operator-checkout=/tmp/source',
      '--backup-parent=/tmp/../backup',
    ],
    [
      '--confirm-copy-only',
      '--expected-main=' + SHA,
      '--operator-checkout=/tmp/source',
      '--backup-parent=/tmp/backup',
      '--apply',
    ],
  ])
    assert.throws(() => parseBackupArgs(argv));
});

test('eligibility refuses overlapping, staged, dirty-other-files and missing upstream status', () => {
  const basic = {
    status: 'preflight-passed',
    safeToConsiderOwnerControlledFastForward: true,
    upToDate: false,
    localSha: 'b'.repeat(40),
    targetSha: SHA,
    reasons: [],
    overlappingPaths: [],
    trackedChanges: 2,
    trackedPaths: ['turbo.json', 'apps/web/next-env.d.ts'],
  };
  assert.deepEqual(validateBackupEligibility(basic), ['apps/web/next-env.d.ts', 'turbo.json']);
  for (const patch of [
    { status: 'blocked' },
    { safeToConsiderOwnerControlledFastForward: false },
    { upToDate: true },
    { reasons: ['staged-or-unresolved-index'] },
    { overlappingPaths: ['turbo.json'] },
    { trackedChanges: 3 },
    { trackedPaths: ['apps/api/.env', 'turbo.json'] },
  ])
    assert.throws(() => validateBackupEligibility({ ...basic, ...patch }));
});

test('real Git fixture backs up two tracked edits, fsyncs owner-private hashes and leaves worktrees/private state untouched', async () => {
  const f = await fixture();
  try {
    const beforeTurbo = await readFile(join(f.root, 'turbo.json'));
    const beforeNext = await readFile(join(f.root, 'apps/web/next-env.d.ts'));
    const out = await createOwnerBackup({
      checkout: f.root,
      parent: f.parent,
      expectedMain: f.expectedMain,
    });
    assert.equal(out.status, 'verified-private-source-backup-only');
    assert.equal(out.trackedFilesPreserved, 2);
    assert.equal(out.sourceHeadSha, f.head);
    assert.equal(out.primaryCheckoutMutated, false);
    assert.equal(out.gitRefsMutated, false);
    assert.equal(out.runtimeRestarted, false);
    const manifest = JSON.parse(await readFile(join(out.backupDirectory, 'manifest.json')));
    assert.equal(manifest.approvedFastForward, false);
    assert.equal(manifest.sourceHeadSha, f.head);
    assert.equal(manifest.externallyPinnedMainSha, f.expectedMain);
    assert.equal(manifest.files.length, 2);
    const originals = new Map([
      ['apps/web/next-env.d.ts', beforeNext],
      ['turbo.json', beforeTurbo],
    ]);
    for (const item of manifest.files) {
      const content = await readFile(join(out.backupDirectory, item.backupFile));
      assert.deepEqual(content, originals.get(item.path));
      assert.equal(item.sha256, digest(content));
      const s = await lstat(join(out.backupDirectory, item.backupFile));
      assert.equal(s.mode & 0o077, 0);
    }
    assert.equal((await lstat(out.backupDirectory)).mode & 0o077, 0);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.head);
    assert.deepEqual(await readFile(join(f.root, 'turbo.json')), beforeTurbo);
    assert.deepEqual(await readFile(join(f.root, 'apps/web/next-env.d.ts')), beforeNext);
    assert.equal(await readFile(join(f.root, '.worktrees', 'preserve.txt'), 'utf8'), 'keep me\n');
    assert.equal(
      await readFile(join(f.root, 'apps/api/.env'), 'utf8'),
      'PRIVATE_KEY_DO_NOT_READ=real-private-data\n',
    );
    assert.equal(JSON.stringify(manifest).includes('PRIVATE_KEY_DO_NOT_READ'), false);
  } finally {
    await cleanup(f);
  }
});

test('fails closed on insecure/symlinked backup parent and unexpected dirty file without writing a snapshot', async () => {
  const f = await fixture();
  const alias = f.parent + '-alias';
  try {
    await chmod(f.parent, 0o755);
    await assert.rejects(
      createOwnerBackup({
        checkout: f.root,
        parent: f.parent,
        expectedMain: f.expectedMain,
      }),
    );
    await chmod(f.parent, 0o700);
    await symlink(f.parent, alias);
    await assert.rejects(
      createOwnerBackup({
        checkout: f.root,
        parent: alias,
        expectedMain: f.expectedMain,
      }),
    );
    await writeFile(join(f.root, 'README.md'), 'unexpected dirty README\n');
    await assert.rejects(
      createOwnerBackup({
        checkout: f.root,
        parent: f.parent,
        expectedMain: f.expectedMain,
      }),
    );
  } finally {
    await rm(alias, { force: true });
    await cleanup(f);
  }
});
