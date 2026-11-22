import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseAuditPinArgs,
  inspectOwnerAudits,
  addOnlyMissingAuditPins,
  runAuditPin,
} from './launch-owner-pin-audit-paths.mjs';

const sha = 'a'.repeat(40);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SECRET = 'SECRET_NOT_TO_APPEAR_IN_RESPONSE';
const KEY_CHECK = 'DEV_HUB_PATCH_CHECK_STATE_DIR';
const KEY_APPLY = 'DEV_HUB_PATCH_APPLY_STATE_DIR';

function git(root, ...args) {
  const p = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 12_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  assert.equal(p.status, 0, 'Isolated Git fixture command');
  return p.stdout.trim();
}
async function fixture() {
  const checkout = await mkdtemp(join(tmpdir(), 'hub-audit-owner-'));
  const backupParent = await mkdtemp(join(tmpdir(), 'hub-audit-backup-'));
  await chmod(backupParent, 0o700);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fixture');
  git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
  await mkdir(join(checkout, 'apps/api/.local'), { recursive: true, mode: 0o700 });
  await chmod(join(checkout, 'apps/api/.local'), 0o700);
  await writeFile(join(checkout, '.gitignore'), 'apps/api/.env\napps/api/.local/\n');
  await writeFile(join(checkout, 'README.md'), 'test fixture\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'fixture source');
  const expectedMain = git(checkout, 'rev-parse', 'HEAD');
  const paths = {};
  const records = {};
  for (const [key, name, n] of [
    [KEY_CHECK, 'patch-checks', 3],
    [KEY_APPLY, 'patch-apply', 2],
  ]) {
    const path = join(checkout, 'apps/api/.local', name);
    const journal = join(path, 'audit.jsonl');
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
    const contents = Array.from(
      { length: n },
      (_, i) =>
        JSON.stringify({ at: '2026-11-22T00:00:00.000Z', event: 'issued', index: i }) + '\n',
    ).join('');
    await writeFile(journal, contents, { mode: 0o600 });
    await chmod(journal, 0o600);
    paths[key] = path;
    records[key] = { journal, contents };
  }
  const envPath = join(checkout, 'apps/api/.env');
  const original = Buffer.from(
    '# owner controls\n' +
      'SECRET=' +
      SECRET +
      '\n' +
      'DEV_HUB_PATCH_CHECK_PNPM_STORE=/existing/other/store\n' +
      'UNRELATED=preserve\n',
  );
  await writeFile(envPath, original, { mode: 0o600 });
  await chmod(envPath, 0o600);
  const noProcesses = async () => ({
    status: 'no-known-operator-processes-at-scan-time',
    totalBlocking: 0,
  });
  return {
    checkout,
    backupParent,
    expectedMain,
    envPath,
    original,
    paths,
    records,
    scan: noProcesses,
    portProbe: async () => true,
    ports: [3100, 3101],
    cleanup: async () => {
      await rm(checkout, { recursive: true, force: true });
      await rm(backupParent, { recursive: true, force: true });
    },
  };
}

test('explicit CLI modes require exact arguments, absolute primary and approved sha', () => {
  assert.deepEqual(
    parseAuditPinArgs([
      '--check-only',
      '--expected-main=' + sha,
      '--operator-checkout=/tmp/primary',
    ]),
    {
      mode: '--check-only',
      expectedMain: sha,
      checkout: '/tmp/primary',
      expectedEnvSha: null,
      backupParent: null,
    },
  );
  const good = [
    '--confirm-private-audit-pin',
    '--expected-main=' + sha,
    '--operator-checkout=/tmp/primary',
    '--expected-env-sha256=' + 'b'.repeat(64),
    '--backup-parent=/tmp/backups',
  ];
  assert.equal(parseAuditPinArgs(good).expectedEnvSha.length, 64);
  for (const args of [
    [],
    ['--confirm-private-audit-pin', ...good.slice(1, 3)],
    ['--check-only', ...good.slice(1)],
    ['--force', ...good.slice(1)],
    [good[0], '--expected-main=invalid', ...good.slice(2)],
    [good[0], good[1], '--operator-checkout=./relative', ...good.slice(3)],
    [good[0], good[1], good[2], '--expected-env-sha256=wrong', good[4]],
    [good[0], good[1], good[2], good[3], '--backup-parent=/tmp/../wrong'],
  ])
    assert.throws(() => parseAuditPinArgs(args));
});

test('read-only inspects existing audit journal history, never prints secrets or changes files', async () => {
  const f = await fixture();
  try {
    const inventory = await inspectOwnerAudits(f.checkout);
    assert.deepEqual(
      inventory.map((v) => v.records),
      [3, 2],
    );
    const report = await runAuditPin({ ...f, mode: '--check-only' });
    assert.equal(report.status, 'existing-audits-require-explicit-env-pin');
    assert.equal(report.envSha256, digest(f.original));
    assert.equal(report.auditJournalsVerified, true);
    assert.equal(report.privateEnvChanged, false);
    assert.equal(report.runtimeRestarted, false);
    assert.deepEqual(
      report.journalEntryCounts.map((x) => x.records),
      [3, 2],
    );
    assert.deepEqual(await readFile(f.envPath), f.original);
    for (const v of Object.values(f.records))
      assert.equal(await readFile(v.journal, 'utf8'), v.contents);
    assert.doesNotMatch(JSON.stringify(report), /SECRET_NOT_TO_APPEAR_IN_RESPONSE/);
    assert.doesNotMatch(JSON.stringify(report), /audit\.jsonl|apps\/api/);
  } finally {
    await f.cleanup();
  }
});

test('manual pin adds only missing keys; retains both audit journals and unrelated env lines', async () => {
  const f = await fixture();
  try {
    const pre = await runAuditPin({ ...f, mode: '--check-only' });
    const result = await runAuditPin({
      ...f,
      mode: '--confirm-private-audit-pin',
      expectedEnvSha: pre.envSha256,
    });
    assert.equal(result.status, 'existing-audit-paths-pinned-restart-required');
    assert.equal(result.privateEnvChanged, true);
    assert.equal(result.auditJournalsChanged, false);
    assert.equal(result.runtimeRestarted, false);
    assert.deepEqual(result.oldJournalEntriesPreserved, [3, 2]);
    const after = await readFile(f.envPath, 'utf8');
    assert.equal(
      after,
      f.original.toString('utf8') +
        KEY_CHECK +
        '=' +
        f.paths[KEY_CHECK] +
        '\n' +
        KEY_APPLY +
        '=' +
        f.paths[KEY_APPLY] +
        '\n',
    );
    assert.equal((await lstat(f.envPath)).mode & 0o077, 0);
    assert.equal((await lstat(result.backupDirectory)).mode & 0o077, 0);
    assert.equal((await lstat(join(result.backupDirectory, 'env.before'))).mode & 0o077, 0);
    assert.deepEqual(await readFile(join(result.backupDirectory, 'env.before')), f.original);
    for (const v of Object.values(f.records))
      assert.equal(await readFile(v.journal, 'utf8'), v.contents);
    const again = await runAuditPin({ ...f, mode: '--check-only' });
    assert.equal(again.status, 'existing-audits-already-explicitly-pinned');
    const noWrite = await runAuditPin({
      ...f,
      mode: '--confirm-private-audit-pin',
      expectedEnvSha: again.envSha256,
    });
    assert.equal(noWrite.status, 'audit-paths-already-pinned-no-write');
    assert.doesNotMatch(JSON.stringify(result), /SECRET_NOT_TO_APPEAR_IN_RESPONSE/);
  } finally {
    await f.cleanup();
  }
});

test('editing helpers preserve CRLF and refuse shadow/duplicate custom audit paths', async () => {
  const f = await fixture();
  try {
    const base = Buffer.from('SECRET=' + SECRET + '\r\nKEEP=x\r\n');
    const out = addOnlyMissingAuditPins(base, f.paths).updated;
    assert.ok(out.includes(Buffer.from('\r\n' + KEY_CHECK + '=')));
    assert.ok(out.includes(Buffer.from('\r\n' + KEY_APPLY + '=')));
    assert.equal(out.toString('utf8').replace(/\r\n/g, '').includes('\n'), false);
    assert.ok(out.toString('utf8').startsWith(base.toString('utf8')));
    for (const invalid of [
      KEY_CHECK + '=/another/path\n',
      KEY_CHECK + '=' + f.paths[KEY_CHECK] + '\nexport ' + KEY_CHECK + '=/other\n',
      '  ' + KEY_CHECK + '=/other\n',
      KEY_CHECK + '=' + f.paths[KEY_CHECK] + '\n' + KEY_CHECK + '=another\n',
      KEY_APPLY + '=/custom/legacy\n',
      KEY_CHECK + '=' + f.paths[KEY_CHECK] + '\r\nOTHER=yes\n',
    ])
      assert.throws(() => addOnlyMissingAuditPins(Buffer.from(invalid), f.paths));
  } finally {
    await f.cleanup();
  }
});

test('busy real operator or stale env SHA blocks write with existing journals intact', async () => {
  const f = await fixture();
  try {
    const pre = await runAuditPin({ ...f, mode: '--check-only' });
    await assert.rejects(
      runAuditPin({
        ...f,
        mode: '--confirm-private-audit-pin',
        expectedEnvSha: pre.envSha256,
        portProbe: async () => false,
      }),
    );
    await assert.rejects(
      runAuditPin({ ...f, mode: '--confirm-private-audit-pin', expectedEnvSha: 'b'.repeat(64) }),
    );
    assert.deepEqual(await readFile(f.envPath), f.original);
    for (const v of Object.values(f.records))
      assert.equal(await readFile(v.journal, 'utf8'), v.contents);
  } finally {
    await f.cleanup();
  }
});

test('refuse missing, truncated, malformed, linked or world-readable original audit', async () => {
  for (const variant of ['missing', 'truncated', 'invalid', 'symlink', 'permissions']) {
    const f = await fixture();
    try {
      const journal = f.records[KEY_CHECK].journal;
      if (variant === 'missing') await rm(journal);
      if (variant === 'truncated') await writeFile(journal, '{"at":"now","event":"issued"}');
      if (variant === 'invalid') await writeFile(journal, '{"at":0,"event":false}\n');
      if (variant === 'symlink') {
        await rm(journal);
        await symlink(f.records[KEY_APPLY].journal, journal);
      }
      if (variant === 'permissions') await chmod(journal, 0o644);
      await assert.rejects(runAuditPin({ ...f, mode: '--check-only' }));
      assert.deepEqual(await readFile(f.envPath), f.original);
    } finally {
      await f.cleanup();
    }
  }
});

test('reject symlink audit directory, unexpected Git origin and linked worktree', async () => {
  const f = await fixture();
  const wt = await mkdtemp(join(tmpdir(), 'hub-audit-linked-'));
  try {
    await rm(wt, { recursive: true });
    git(f.checkout, 'worktree', 'add', '-q', '-b', 'linked-fixture', wt, f.expectedMain);
    await assert.rejects(runAuditPin({ ...f, mode: '--check-only', checkout: wt }));
    git(f.checkout, 'remote', 'set-url', 'origin', 'git@github.com:other/repo.git');
    await assert.rejects(runAuditPin({ ...f, mode: '--check-only' }));
    git(f.checkout, 'remote', 'set-url', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
    const folder = f.paths[KEY_APPLY];
    await rm(folder, { recursive: true });
    await symlink(f.paths[KEY_CHECK], folder);
    await assert.rejects(runAuditPin({ ...f, mode: '--check-only' }));
  } finally {
    git(f.checkout, 'worktree', 'remove', '--force', wt);
    await f.cleanup();
  }
});

test('journal mutation during owner shutdown recheck aborts pin and preserves .env', async () => {
  const f = await fixture();
  try {
    const pre = await runAuditPin({ ...f, mode: '--check-only' });
    let scans = 0;
    const changingScan = async () => {
      scans++;
      if (scans === 2)
        await writeFile(
          f.records[KEY_APPLY].journal,
          f.records[KEY_APPLY].contents +
            JSON.stringify({ at: '2026-11-22T00:10:00Z', event: 'rejected' }) +
            '\n',
        );
      return { status: 'no-known-operator-processes-at-scan-time', totalBlocking: 0 };
    };
    await assert.rejects(
      runAuditPin({
        ...f,
        mode: '--confirm-private-audit-pin',
        expectedEnvSha: pre.envSha256,
        scan: changingScan,
      }),
    );
    assert.deepEqual(await readFile(f.envPath), f.original);
    assert.equal(scans, 2);
  } finally {
    await f.cleanup();
  }
});
