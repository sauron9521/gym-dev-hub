import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUnitArgs, renderUserUnit, verifyUnitInput } from './launch-systemd-user-unit.mjs';

const root = '/home/owner/Projects/gym-dev-hub';
const nodeBin = '/home/owner/.nvm/versions/node/v24.22.3/bin/node';
const pnpmDir = dirname(nodeBin);
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 12_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  assert.equal(r.status, 0, 'Temporary fixture Git setup');
  return r.stdout.trim();
}
async function fixture() {
  const checkout = await mkdtemp(join(tmpdir(), 'hub-systemd-owner-'));
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fixture');
  git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
  await mkdir(join(checkout, 'scripts'));
  await writeFile(join(checkout, 'scripts/dev-operator.mjs'), 'console.log("fixture only")\n');
  await writeFile(
    join(checkout, 'package.json'),
    JSON.stringify({
      packageManager: 'pnpm@12.18.0',
      scripts: { 'dev:operator': 'node scripts/dev-operator.mjs' },
    }),
  );
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'Fixture');
  return {
    checkout,
    cleanup: async () => rm(checkout, { recursive: true, force: true }),
  };
}
test('CLI modes are read-only and require exact canonical primary checkout', () => {
  assert.deepEqual(parseUnitArgs(['--check-only', '--operator-checkout=' + root]), {
    mode: '--check-only',
    checkout: root,
  });
  assert.deepEqual(parseUnitArgs(['--print-unit', '--operator-checkout=' + root]), {
    mode: '--print-unit',
    checkout: root,
  });
  for (const a of [
    [],
    ['--install'],
    ['--enable', '--operator-checkout=' + root],
    ['--print-unit'],
    ['--print-unit', '--operator-checkout=./hub'],
    ['--check-only', '--operator-checkout=/tmp/../unsafe'],
    ['--print-unit', '--operator-checkout=/tmp/a b'],
    ['--print-unit', '--operator-checkout=/tmp/with%specifier'],
    ['--print-unit', '--operator-checkout=' + root, '--now'],
  ])
    assert.throws(() => parseUnitArgs(a));
});
test('generated user unit has bounded restart, no shell and no implicit enable/linger', () => {
  const unit = renderUserUnit({ checkout: root, nodeBin, pnpmDir });
  assert.match(unit, /^\[Unit\]$/m);
  assert.match(unit, /StartLimitIntervalSec=600/);
  assert.match(unit, /StartLimitBurst=2/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartSec=45s/);
  assert.match(unit, /KillMode=control-group/);
  assert.match(unit, /TimeoutStopSec=12s/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /WantedBy=default.target/);
  assert.match(unit, /WorkingDirectory=\/home\/owner\/Projects\/gym-dev-hub/);
  assert.match(
    unit,
    /ExecStart=\/home\/owner\/\.nvm\/versions\/node\/v24\.22\.3\/bin\/node \/home\/owner\/Projects\/gym-dev-hub\/scripts\/dev-operator\.mjs/,
  );
  assert.match(unit, /Environment="DOCKER_HOST=unix:\/\/\/var\/run\/docker.sock"/);
  assert.match(unit, /Environment="DOCKER_CONTEXT=default"/);
  assert.doesNotMatch(
    unit,
    /systemctl|loginctl|ExecStartPre=|EnvironmentFile=|\/bin\/sh|\/bin\/bash|sudo|sg docker|--watch|chmod 666|Bearer|SECRET/,
  );
  assert.equal(unit, renderUserUnit({ checkout: root, nodeBin, pnpmDir }));
});
test('rejects path interpolation, whitespace and non-canonical unit executables', () => {
  for (const bad of [
    '../repo',
    '/home/owner/sp ace',
    '/home/owner/repo;halt',
    '/home/owner/repo%h',
    '/home/owner/repo\nNext=bad',
    '/home/owner/../other',
    '/home//owner/repo',
  ])
    assert.throws(() => renderUserUnit({ checkout: bad, nodeBin, pnpmDir }));
  assert.throws(() => renderUserUnit({ checkout: root, nodeBin: 'node', pnpmDir }));
  assert.throws(() => renderUserUnit({ checkout: root, nodeBin, pnpmDir: '/tmp/foo#comment' }));
});
test('fixture primary is verified and read-only unit report does not change source', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux owner-only service');
  const f = await fixture();
  try {
    const original = await readFile(join(f.checkout, 'package.json'));
    const lastHead = git(f.checkout, 'rev-parse', 'HEAD');
    const x = await verifyUnitInput(f.checkout);
    assert.equal(x.status, 'read-only-user-unit-ready');
    assert.match(x.unitSha256, /^[a-f0-9]{64}$/);
    assert.equal(x.loginTargetAutostartPolicy, true);
    assert.equal(x.bootBeforeLoginRequestedByTool, false);
    assert.equal(x.systemdFilesWritten, false);
    assert.equal(x.userUnitEnabledByTool, false);
    assert.equal(x.servicesRestarted, false);
    assert.equal(x.lingerChanged, false);
    assert.match(x.unit, /WantedBy=default.target/);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), lastHead);
    assert.deepEqual(await readFile(join(f.checkout, 'package.json')), original);
  } finally {
    await f.cleanup();
  }
});
test('untrusted fork, wrong branch, malformed package metadata reject rendering', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux owner-only service');
  const f = await fixture();
  try {
    git(f.checkout, 'remote', 'set-url', 'origin', 'git@github.com:other/repo.git');
    await assert.rejects(verifyUnitInput(f.checkout));
    git(f.checkout, 'remote', 'set-url', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
    git(f.checkout, 'checkout', '-q', '-b', 'foreign');
    await assert.rejects(verifyUnitInput(f.checkout));
    git(f.checkout, 'checkout', '-q', 'main');
    await writeFile(join(f.checkout, 'package.json'), '{}');
    await assert.rejects(verifyUnitInput(f.checkout));
  } finally {
    await f.cleanup();
  }
});
test('linked worktrees and symlinked primary checkout are rejected', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux owner-only service');
  const f = await fixture();
  const linked = await mkdtemp(join(tmpdir(), 'hub-systemd-linked-'));
  const symlinkPath = join(tmpdir(), 'hub-systemd-symlink-fixture-' + process.pid);
  try {
    await rm(linked, { recursive: true });
    git(f.checkout, 'worktree', 'add', '-q', '-b', 'linked', linked, 'main');
    await assert.rejects(verifyUnitInput(linked));
    await symlink(f.checkout, symlinkPath);
    await assert.rejects(verifyUnitInput(symlinkPath));
  } finally {
    git(f.checkout, 'worktree', 'remove', '--force', linked);
    await rm(symlinkPath, { force: true });
    await f.cleanup();
  }
});
test('systemd verify accepts generated static fixture service syntax', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux only');
  const f = await fixture();
  const scratch = await mkdtemp(join(tmpdir(), 'hub-unit-verify-'));
  try {
    const x = await verifyUnitInput(f.checkout);
    const path = join(scratch, 'gym-dev-hub-operator.service');
    await writeFile(path, x.unit, { mode: 0o600 });
    const r = spawnSync('systemd-analyze', ['verify', path], {
      encoding: 'utf8',
      timeout: 12_000,
      maxBuffer: 8192,
    });
    assert.equal(
      r.status,
      0,
      'Only temporary systemd syntax verified: ' + (r.stderr || '').slice(0, 400),
    );
    assert.equal((await lstat(path)).mode & 0o077, 0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await f.cleanup();
  }
});
