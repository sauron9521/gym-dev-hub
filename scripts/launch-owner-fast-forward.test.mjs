import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnerBackup } from './launch-source-owner-backup.mjs';
import {
  parseOwnerFastForwardArgs,
  runOwnerFastForward,
  portsAvailable,
} from './launch-owner-fast-forward.mjs';

function git(root, ...args) {
  const run = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 12_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  assert.equal(run.status, 0, 'Fixture Git command failed');
  return run.stdout.trim();
}
async function createFixture() {
  const checkout = await mkdtemp(join(tmpdir(), 'owner-ff-source-'));
  const parent = await mkdtemp(join(tmpdir(), 'owner-ff-private-'));
  await chmod(parent, 0o700);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fixture Operator');
  git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
  await mkdir(join(checkout, 'apps/web'), { recursive: true });
  await mkdir(join(checkout, 'apps/api'), { recursive: true });
  await writeFile(join(checkout, 'turbo.json'), '{"base":true}\n');
  await writeFile(join(checkout, 'apps/web/next-env.d.ts'), '// base-next\n');
  await writeFile(join(checkout, 'README.md'), 'fixture source\n');
  await writeFile(join(checkout, '.gitignore'), 'apps/api/.env\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'baseline');
  const oldHead = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', '-b', 'future');
  await writeFile(join(checkout, 'docs.md'), 'upstream change\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'future');
  const initialTarget = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', 'main');
  const originalTurbo = '{"locallyCustomized":true}\n';
  const originalNext = '// local types\n';
  await writeFile(join(checkout, 'turbo.json'), originalTurbo);
  await writeFile(join(checkout, 'apps/web/next-env.d.ts'), originalNext);
  await mkdir(join(checkout, '.worktrees'));
  await writeFile(join(checkout, '.worktrees/keep.txt'), 'preserve-local-worktrees\n');
  await writeFile(join(checkout, 'apps/api/.env'), 'OWNER_SECRET_NOT_TO_BE_LOGGED=private\n');
  const backup = await createOwnerBackup({ checkout, parent, expectedMain: initialTarget });
  // Main advanced again AFTER backup, without changing either locally edited path.
  git(checkout, 'checkout', '-q', 'future');
  await writeFile(join(checkout, 'docs-2.md'), 'newer upstream change\n');
  git(checkout, 'add', '--', 'docs-2.md');
  git(checkout, 'commit', '-q', '-m', 'newer future');
  const expectedMain = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', 'main');
  return {
    checkout,
    parent,
    backup: backup.backupDirectory,
    oldHead,
    expectedMain,
    initialTarget,
    originalTurbo,
    originalNext,
  };
}
async function removeFixture(f) {
  await rm(f.checkout, { recursive: true, force: true });
  await rm(f.parent, { recursive: true, force: true });
}
async function freePort() {
  const srv = createServer();
  await new Promise((resolveWait) => srv.listen(0, '127.0.0.1', resolveWait));
  const port = srv.address().port;
  await new Promise((resolveWait) => srv.close(resolveWait));
  return port;
}
async function busyPort() {
  const srv = createServer();
  await new Promise((resolveWait) => srv.listen(0, '127.0.0.1', resolveWait));
  return srv;
}

test('CLI is exact and refuses unapproved command flags or relative paths', () => {
  const args = [
    '--check-only',
    '--expected-main=' + 'a'.repeat(40),
    '--operator-checkout=/tmp/primary',
    '--verified-backup=/tmp/owner-private/backup',
  ];
  assert.deepEqual(parseOwnerFastForwardArgs(args), {
    mode: '--check-only',
    expectedMain: 'a'.repeat(40),
    checkout: '/tmp/primary',
    backup: '/tmp/owner-private/backup',
  });
  assert.equal(
    parseOwnerFastForwardArgs(['--confirm-owner-fast-forward', ...args.slice(1)]).mode,
    '--confirm-owner-fast-forward',
  );
  for (const candidate of [
    args.slice(1),
    args.concat('--force'),
    ['--confirm-reset-hard', ...args.slice(1)],
    ['--confirm-owner-fast-forward', '--expected-main=nope', ...args.slice(2)],
    ['--check-only', args[1], '--operator-checkout=../source', args[3]],
    ['--check-only', args[1], args[2], '--verified-backup=/tmp/../backup'],
    [args[0], args[1], args[2], '--verified-backup=/tmp/primary'],
  ])
    assert.throws(() => parseOwnerFastForwardArgs(candidate));
});

test('real busy port blocks even owner-confirmed mode without any Git write', async () => {
  const f = await createFixture();
  const busy = await busyPort();
  try {
    const port = busy.address().port;
    assert.equal(await portsAvailable([port]), false);
    const out = await runOwnerFastForward({
      mode: '--confirm-owner-fast-forward',
      expectedMain: f.expectedMain,
      checkout: f.checkout,
      backup: f.backup,
      ports: [port],
      processInspector: async () => ({
        status: 'no-known-operator-processes-at-scan-time',
        totalBlocking: 0,
      }),
    });
    assert.equal(out.status, 'blocked-operator-ports-active');
    assert.equal(out.gitWritesPerformed, false);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.oldHead);
    assert.equal(await readFile(join(f.checkout, 'turbo.json'), 'utf8'), f.originalTurbo);
  } finally {
    await new Promise((resolveWait) => busy.close(resolveWait));
    await removeFixture(f);
  }
});

test('real Git fast-forward preserves the two dirty files, .worktrees and ignored env and bypasses hooks', async () => {
  const f = await createFixture();
  try {
    const port = await freePort();
    assert.equal(await portsAvailable([port]), true);
    const dry = await runOwnerFastForward({
      mode: '--check-only',
      expectedMain: f.expectedMain,
      checkout: f.checkout,
      backup: f.backup,
      ports: [port],
      processInspector: async () => ({
        status: 'no-known-operator-processes-at-scan-time',
        totalBlocking: 0,
      }),
    });
    assert.equal(dry.status, 'owner-cutover-preflight-passed');
    assert.equal(dry.gitWritesPerformed, false);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.oldHead);
    // If a post-merge hook is configured, this explicit one-off ff must not run it.
    await writeFile(
      join(f.checkout, '.git/hooks/post-merge'),
      '#!/bin/sh\nprintf did-run > "' + join(f.checkout, 'hook-ran') + '"\n',
      { mode: 0o755 },
    );
    await chmod(join(f.checkout, '.git/hooks/post-merge'), 0o755);
    const done = await runOwnerFastForward({
      mode: '--confirm-owner-fast-forward',
      expectedMain: f.expectedMain,
      checkout: f.checkout,
      backup: f.backup,
      ports: [port],
      processInspector: async () => ({
        status: 'no-known-operator-processes-at-scan-time',
        totalBlocking: 0,
      }),
    });
    assert.equal(done.status, 'owner-fast-forward-verified');
    assert.equal(done.gitWritesPerformed, true);
    assert.equal(done.runtimeRestarted, false);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.expectedMain);
    assert.equal(await readFile(join(f.checkout, 'turbo.json'), 'utf8'), f.originalTurbo);
    assert.equal(
      await readFile(join(f.checkout, 'apps/web/next-env.d.ts'), 'utf8'),
      f.originalNext,
    );
    assert.equal(
      await readFile(join(f.checkout, '.worktrees/keep.txt'), 'utf8'),
      'preserve-local-worktrees\n',
    );
    assert.equal(
      await readFile(join(f.checkout, 'apps/api/.env'), 'utf8'),
      'OWNER_SECRET_NOT_TO_BE_LOGGED=private\n',
    );
    await assert.rejects(readFile(join(f.checkout, 'hook-ran')));
    assert.equal(await readFile(join(f.checkout, 'docs.md'), 'utf8'), 'upstream change\n');
    assert.equal(await readFile(join(f.checkout, 'docs-2.md'), 'utf8'), 'newer upstream change\n');
    assert.equal(
      JSON.parse(await readFile(join(f.backup, 'manifest.json'))).sourceHeadSha,
      f.oldHead,
    );
  } finally {
    await removeFixture(f);
  }
});

test('fail closed for tampered backups and unexpected untracked files, never changes HEAD', async () => {
  const f = await createFixture();
  try {
    const port = await freePort();
    await writeFile(join(f.backup, 'turbo.json'), '{"tampered":true}\n');
    await assert.rejects(
      runOwnerFastForward({
        mode: '--confirm-owner-fast-forward',
        expectedMain: f.expectedMain,
        checkout: f.checkout,
        backup: f.backup,
        ports: [port],
        processInspector: async () => ({
          status: 'no-known-operator-processes-at-scan-time',
          totalBlocking: 0,
        }),
      }),
    );
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.oldHead);
  } finally {
    await removeFixture(f);
  }
  const g = await createFixture();
  try {
    const port = await freePort();
    await writeFile(join(g.checkout, 'unexpected.txt'), 'extra file\n');
    await assert.rejects(
      runOwnerFastForward({
        mode: '--confirm-owner-fast-forward',
        expectedMain: g.expectedMain,
        checkout: g.checkout,
        backup: g.backup,
        ports: [port],
        processInspector: async () => ({
          status: 'no-known-operator-processes-at-scan-time',
          totalBlocking: 0,
        }),
      }),
    );
    assert.equal(git(g.checkout, 'rev-parse', 'HEAD'), g.oldHead);
  } finally {
    await removeFixture(g);
  }
});

test('refuses linked-worktree checkout and symlinked backup before any Git write', async () => {
  const f = await createFixture();
  const alias = f.backup + '-alias';
  try {
    const port = await freePort();
    await symlink(f.backup, alias);
    await assert.rejects(
      runOwnerFastForward({
        mode: '--confirm-owner-fast-forward',
        expectedMain: f.expectedMain,
        checkout: f.checkout,
        backup: alias,
        ports: [port],
        processInspector: async () => ({
          status: 'no-known-operator-processes-at-scan-time',
          totalBlocking: 0,
        }),
      }),
    );
    const wt = await mkdtemp(join(tmpdir(), 'owner-ff-linked-'));
    await rm(wt, { recursive: true });
    git(f.checkout, 'worktree', 'add', '-q', '-b', 'otherbranch', wt, f.oldHead);
    try {
      await assert.rejects(
        runOwnerFastForward({
          mode: '--confirm-owner-fast-forward',
          expectedMain: f.expectedMain,
          checkout: wt,
          backup: f.backup,
          ports: [port],
          processInspector: async () => ({
            status: 'no-known-operator-processes-at-scan-time',
            totalBlocking: 0,
          }),
        }),
      );
    } finally {
      git(f.checkout, 'worktree', 'remove', '--force', wt);
    }
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.oldHead);
  } finally {
    await rm(alias, { force: true });
    await removeFixture(f);
  }
});

test('port-free cutover still blocks a surviving Node supervisor detected by process provenance', async () => {
  const f = await createFixture();
  try {
    const port = await freePort();
    const report = await runOwnerFastForward({
      mode: '--confirm-owner-fast-forward',
      expectedMain: f.expectedMain,
      checkout: f.checkout,
      backup: f.backup,
      ports: [port],
      processInspector: async () => ({
        status: 'operator-processes-not-confirmed-stopped',
        totalBlocking: 1,
      }),
    });
    assert.equal(report.status, 'blocked-operator-processes-active');
    assert.equal(report.backupVerified, true);
    assert.equal(report.gitWritesPerformed, false);
    assert.equal(report.runtimeRestarted, false);
    assert.equal(report.detectedOperatorProcesses, 1);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.oldHead);
    assert.equal(await readFile(join(f.checkout, 'turbo.json'), 'utf8'), f.originalTurbo);
  } finally {
    await removeFixture(f);
  }
});

test('refuses inconsistent or unavailable process scanner, never authorizes a write', async () => {
  const f = await createFixture();
  try {
    const port = await freePort();
    await assert.rejects(
      runOwnerFastForward({
        mode: '--confirm-owner-fast-forward',
        expectedMain: f.expectedMain,
        checkout: f.checkout,
        backup: f.backup,
        ports: [port],
        processInspector: async () => ({
          status: 'no-known-operator-processes-at-scan-time',
          totalBlocking: 9,
        }),
      }),
    );
    await assert.rejects(
      runOwnerFastForward({
        mode: '--confirm-owner-fast-forward',
        expectedMain: f.expectedMain,
        checkout: f.checkout,
        backup: f.backup,
        ports: [port],
        processInspector: async () => {
          throw Error('Unreadable proc');
        },
      }),
    );
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.oldHead);
  } finally {
    await removeFixture(f);
  }
});
