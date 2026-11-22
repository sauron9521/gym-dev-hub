import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseOwnerStartArgs,
  runOwnerSystemdStart,
  validatePinnedSource,
  httpHealth,
} from './launch-owner-systemd-start.mjs';

const ROOT = '/home/owner/Projects/gym-dev-hub';
const SHA = 'a'.repeat(40);
const PID = 12345;
const TICKS = '998877';
function show(active, pid = PID, checkout = ROOT) {
  return [
    'Id=gym-dev-hub-operator.service',
    'LoadState=loaded',
    'ActiveState=' + (active ? 'active' : 'inactive'),
    'SubState=' + (active ? 'running' : 'dead'),
    'UnitFileState=enabled',
    'MainPID=' + (active ? pid : 0),
    'WorkingDirectory=' + checkout,
    '',
  ].join('\n');
}
const verified = {
  status: 'exact-operator-supervisor-verified',
  sourceCheckoutCanonical: true,
  processOwnerVerified: true,
  scriptIdentityVerified: true,
  startTicks: TICKS,
};
function controls(opts = {}) {
  let starts = 0;
  let running = false;
  const testDeps = {
    source: async () => true,
    unit: async () => show(running),
    processes: async () => ({
      status: 'no-known-operator-processes-at-scan-time',
      totalBlocking: 0,
    }),
    freePorts: async () => true,
    start: async () => {
      starts++;
      running = true;
    },
    inspect: async () => verified,
    health: async () => true,
    sleep: async () => {},
    maxChecks: 3,
    ...opts,
  };
  return { testDeps, getStarts: () => starts, running: () => running };
}
function request(mode = '--check-only') {
  return { mode, checkout: ROOT, expectedMain: SHA };
}
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 8000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  assert.equal(r.status, 0, 'Fixture git');
  return r.stdout.trim();
}
async function fixture() {
  const checkout = await mkdtemp(join(tmpdir(), 'hub-owner-start-'));
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fixture');
  git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
  await mkdir(join(checkout, 'apps/api/dist'), { recursive: true });
  await writeFile(join(checkout, 'apps/api/dist/main.js'), 'console.log("fixture only")\n');
  await writeFile(join(checkout, 'README.md'), 'source fixture\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'fixture baseline');
  return { checkout, sha: git(checkout, 'rev-parse', 'HEAD') };
}

test('CLI accepts only fixed owner check/start modes, 40hex main and canonical checkout', () => {
  const args = ['--check-only', '--expected-main=' + SHA, '--operator-checkout=' + ROOT];
  assert.deepEqual(parseOwnerStartArgs(args), request());
  assert.equal(
    parseOwnerStartArgs(['--confirm-owner-systemd-start', ...args.slice(1)]).mode,
    '--confirm-owner-systemd-start',
  );
  for (const bad of [
    [],
    args.concat('--restart'),
    ['--start', ...args.slice(1)],
    [args[0], '--expected-main=main', args[2]],
    [args[0], args[1], '--operator-checkout=../src'],
    [args[0], args[1], '--operator-checkout=/tmp/../src'],
    ['--confirm-owner-systemd-start', args[1], args[2], '--stop'],
  ])
    assert.throws(() => parseOwnerStartArgs(bad));
});

test('preflight stays read-only and requires stopped unit, no known children and free ports', async () => {
  const t = controls();
  const r = await runOwnerSystemdStart(request(), t.testDeps);
  assert.equal(r.status, 'owner-systemd-start-preflight-only');
  assert.equal(r.systemdStartRequested, false);
  assert.equal(r.httpHealthVerified, false);
  assert.equal(r.endToEndVerified, false);
  assert.equal(t.getStarts(), 0);
});

test('blocked inactive-state, surviving processes or busy ports never start', async () => {
  for (const overrides of [
    { unit: async () => show(true) },
    { unit: async () => show(false, PID, '/tmp/foreign') },
    { unit: async () => show(false).replace('UnitFileState=enabled', 'UnitFileState=disabled') },
    {
      processes: async () => ({
        status: 'operator-processes-not-confirmed-stopped',
        totalBlocking: 1,
      }),
    },
    { freePorts: async () => false },
    {
      source: async () => {
        throw new Error('source drift');
      },
    },
  ]) {
    const t = controls(overrides);
    await assert.rejects(() =>
      runOwnerSystemdStart(request('--confirm-owner-systemd-start'), t.testDeps),
    );
    assert.equal(t.getStarts(), 0);
  }
});

test('one owner-approved start followed by stable PID, birthtime, exact source and both HTTP 200', async () => {
  const t = controls();
  const result = await runOwnerSystemdStart(request('--confirm-owner-systemd-start'), t.testDeps);
  assert.equal(t.getStarts(), 1);
  assert.equal(result.status, 'owner-systemd-start-health-verified');
  assert.equal(result.systemdStartRequested, true);
  assert.equal(result.httpHealthVerified, true);
  assert.equal(result.activeSupervisorIdentityVerified, true);
  assert.equal(result.loadedSourceCryptographicallyAttested, false);
  assert.equal(result.endToEndVerified, false);
  assert.equal(result.sourceMutated, false);
  assert.equal(result.dockerExecuted, false);
});

test('missing HTTP health never retries start or stops service, even on timeouts', async () => {
  const t = controls({ health: async () => false, maxChecks: 2 });
  await assert.rejects(
    () => runOwnerSystemdStart(request('--confirm-owner-systemd-start'), t.testDeps),
    /START_OUTCOME_UNVERIFIED/,
  );
  assert.equal(t.getStarts(), 1);
  assert.equal(t.running(), true);
});

test('PID rollover and process birthtime races prevent false successful startup', async () => {
  for (const scenario of ['pid', 'ticks']) {
    let reads = 0;
    let inspections = 0;
    const t = controls({
      unit: async () =>
        show(t.running(), scenario === 'pid' && t.running() && ++reads % 2 === 0 ? PID + 1 : PID),
      inspect: async () =>
        scenario === 'ticks'
          ? { ...verified, startTicks: ++inspections % 2 === 0 ? '7654321' : TICKS }
          : verified,
      maxChecks: 2,
    });
    await assert.rejects(
      () => runOwnerSystemdStart(request('--confirm-owner-systemd-start'), t.testDeps),
      /START_OUTCOME_UNVERIFIED/,
    );
    assert.equal(t.getStarts(), 1);
  }
});

test('ambiguous systemd start response never retries, clears, disables or resets source', async () => {
  let count = 0;
  const t = controls({
    start: async () => {
      count++;
      throw new Error('lost systemd response');
    },
  });
  await assert.rejects(
    () => runOwnerSystemdStart(request('--confirm-owner-systemd-start'), t.testDeps),
    /lost systemd response/,
  );
  assert.equal(count, 1);
});

test('only .worktrees/ may remain untracked before an owner systemd start', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    // Prior gate accepted ANY one untracked entry based on its count alone.
    await writeFile(join(f.checkout, 'unexpected-owner-file.txt'), 'do not touch\n');
    await assert.rejects(
      () => validatePinnedSource(f.checkout, f.sha),
      /Owner source not at externally pinned main or has unsafe edits/,
    );
    await rm(join(f.checkout, 'unexpected-owner-file.txt'));

    await mkdir(join(f.checkout, '.worktrees'));
    await writeFile(join(f.checkout, '.worktrees', 'owner-plan.txt'), 'preserve\n');
    await assert.doesNotReject(() => validatePinnedSource(f.checkout, f.sha));

    await writeFile(join(f.checkout, 'unrelated-note.txt'), 'should block\n');
    await assert.rejects(
      () => validatePinnedSource(f.checkout, f.sha),
      /Owner source not at externally pinned main or has unsafe edits/,
    );
    await rm(join(f.checkout, 'unrelated-note.txt'));
    await rm(join(f.checkout, '.worktrees'), { recursive: true });

    await symlink('README.md', join(f.checkout, '.worktrees'));
    await assert.rejects(
      () => validatePinnedSource(f.checkout, f.sha),
      /Owner source not at externally pinned main or has unsafe edits/,
    );
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('real physical owner Git fixture accepts exact built main and rejects stale SHA/foreign origin', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    await assert.doesNotReject(() => validatePinnedSource(f.checkout, f.sha));
    await assert.rejects(() => validatePinnedSource(f.checkout, SHA), /owner source|unsafe edits/);
    git(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    await assert.rejects(
      () => validatePinnedSource(f.checkout, f.sha),
      /owner source|unsafe edits/,
    );
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('cold Next.js first request may take over 1500 ms, but an actual delayed HTTP 200 is accepted', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/unhealthy') {
      res.writeHead(503).end();
      return;
    }
    setTimeout(() => res.writeHead(200).end('healthy'), 1900);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(await httpHealth(address.port, '/unhealthy'), false);
    assert.equal(await httpHealth(address.port, '/slow-cold-start'), true);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('cold Web readiness after 17 initially failed probes passes with one single owner start', async () => {
  let clock = 0;
  let checks = 0;
  const t = controls({
    health: async () => ++checks >= 18,
    maxChecks: 24,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    healthWindowMs: 20_000,
  });
  const result = await runOwnerSystemdStart(request('--confirm-owner-systemd-start'), t.testDeps);
  assert.equal(result.status, 'owner-systemd-start-health-verified');
  assert.equal(result.httpHealthVerified, true);
  assert.equal(result.endToEndVerified, false);
  assert.equal(t.getStarts(), 1);
  assert.equal(checks, 18);
  assert.ok(clock > 9000 && clock < 20_000);
});

test('monotonic startup verification deadline fails closed, never restarts or stops service', async () => {
  let clock = 0;
  let checks = 0;
  const t = controls({
    health: async () => {
      checks++;
      return false;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    maxChecks: 24,
    healthWindowMs: 2000,
  });
  await assert.rejects(
    () => runOwnerSystemdStart(request('--confirm-owner-systemd-start'), t.testDeps),
    /START_OUTCOME_UNVERIFIED/,
  );
  assert.equal(clock, 2000);
  assert.equal(checks, 4);
  assert.equal(t.getStarts(), 1);
  assert.equal(t.running(), true);
});

test('health response after deadline cannot claim a successful startup', async () => {
  let clock = 0;
  let checks = 0;
  const t = controls({
    health: async () => {
      checks++;
      clock += 2100;
      return true;
    },
    now: () => clock,
    healthWindowMs: 2000,
  });
  await assert.rejects(
    () => runOwnerSystemdStart(request('--confirm-owner-systemd-start'), t.testDeps),
    /START_OUTCOME_UNVERIFIED/,
  );
  assert.equal(checks, 1);
  assert.equal(t.getStarts(), 1);
  assert.equal(t.running(), true);
});

test('invalid post-start timing policy is rejected BEFORE a systemd start', async () => {
  for (const bad of [
    { maxChecks: 25 },
    { maxChecks: 0 },
    { healthWindowMs: 31_000 },
    { healthWindowMs: 0 },
    { now: null },
  ]) {
    const t = controls(bad);
    await assert.rejects(
      () => runOwnerSystemdStart(request('--confirm-owner-systemd-start'), t.testDeps),
      /Invalid bounded post-start policy/,
    );
    assert.equal(t.getStarts(), 0);
  }
});
