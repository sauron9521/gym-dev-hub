import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSystemdStopArgs,
  parseStoppedUserUnit,
  runOwnerSystemdStop,
} from './launch-owner-systemd-stop.mjs';
import { parseUserUnitShow } from './launch-systemd-runtime-preflight.mjs';

const SHA = 'a'.repeat(40);
const CHECKOUT = '/home/owner/Projects/gym-dev-hub';
const PID = 12549;
const TICKS = '1937548';
const KEYS = [
  'Id=gym-dev-hub-operator.service',
  'LoadState=loaded',
  'ActiveState=active',
  'SubState=running',
  'UnitFileState=enabled',
  'MainPID=' + PID,
  'WorkingDirectory=' + CHECKOUT,
];
const activeUnit = (checkout, pid = PID) =>
  parseUserUnitShow(
    [...KEYS.slice(0, 5), 'MainPID=' + pid, 'WorkingDirectory=' + checkout, ''].join('\n'),
  );
const stoppedLines = (checkout) =>
  [
    ...KEYS.slice(0, 2),
    'ActiveState=inactive',
    'SubState=dead',
    'UnitFileState=enabled',
    'MainPID=0',
    'WorkingDirectory=' + checkout,
    '',
  ].join('\n');
const identity = Object.freeze({
  status: 'exact-operator-supervisor-verified',
  startTicks: TICKS,
  processOwnerVerified: true,
  scriptIdentityVerified: true,
  sourceCheckoutCanonical: true,
});
function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 9000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  assert.equal(result.status, 0, 'Fixture git operation');
  return result.stdout.trim();
}
async function fixture() {
  const checkout = await mkdtemp(join(tmpdir(), 'hub-user-systemd-stop-'));
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fixture');
  git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
  await writeFile(join(checkout, 'README.md'), 'fixture only\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'fixture');
  return { checkout, sha: git(checkout, 'rev-parse', 'HEAD') };
}
function deps(checkout, overrides = {}) {
  return {
    readLive: async () => activeUnit(checkout),
    inspect: async () => identity,
    readStopped: async () => parseStoppedUserUnit(stoppedLines(checkout)),
    stop: async () => {
      throw new Error('Test must not invoke the real systemd stop');
    },
    scan: async () => ({
      status: 'no-known-operator-processes-at-scan-time',
      totalBlocking: 0,
    }),
    checkPorts: async () => true,
    ...overrides,
  };
}

test('only fixed inspect-only and exact owner-approved stop CLI are accepted', () => {
  const preview = [
    '--inspect-only',
    '--expected-owner-head=' + SHA,
    '--operator-checkout=' + CHECKOUT,
  ];
  assert.deepEqual(parseSystemdStopArgs(preview), {
    mode: '--inspect-only',
    expectedOwnerHead: SHA,
    checkout: CHECKOUT,
    pid: null,
    startTicks: null,
  });
  const confirm = [
    '--confirm-owner-systemd-stop',
    ...preview.slice(1),
    '--supervisor-pid=' + PID,
    '--expected-start-ticks=' + TICKS,
  ];
  assert.equal(parseSystemdStopArgs(confirm).pid, PID);
  for (const rejected of [
    [],
    preview.concat('--confirm'),
    confirm.concat('--restart'),
    ['--confirm-owner-systemd-stop', ...preview.slice(1)],
    ['--force', ...confirm.slice(1)],
    ['--inspect-only', '--expected-owner-head=main', preview[2]],
    ['--inspect-only', preview[1], '--operator-checkout=/tmp/../unsafe'],
    [confirm[0], confirm[1], confirm[2], '--supervisor-pid=1', confirm[4]],
    [confirm[0], confirm[1], confirm[2], confirm[3], '--expected-start-ticks=abc'],
  ])
    assert.throws(() => parseSystemdStopArgs(rejected));
});

test('post-stop parser fails closed on residual service, forged ID or extra data', () => {
  assert.deepEqual(parseStoppedUserUnit(stoppedLines(CHECKOUT)), {
    checkout: CHECKOUT,
    status: 'inactive-dead',
    pid: 0,
  });
  for (const bad of [
    stoppedLines(CHECKOUT).replace('MainPID=0', 'MainPID=5'),
    stoppedLines(CHECKOUT).replace('ActiveState=inactive', 'ActiveState=active'),
    stoppedLines(CHECKOUT).replace('SubState=dead', 'SubState=failed'),
    stoppedLines(CHECKOUT).replace('Id=gym-dev-hub-operator.service', 'Id=foreign.service'),
    stoppedLines(CHECKOUT).replace(
      'WorkingDirectory=' + CHECKOUT,
      'WorkingDirectory=/tmp/../unsafe',
    ),
    stoppedLines(CHECKOUT) + 'Environment=SECRETS\n',
    stoppedLines(CHECKOUT).replace('MainPID=0\n', ''),
  ])
    assert.throws(() => parseStoppedUserUnit(bad));
});

test('inspecting owner unit is read-only and never certifies current loaded code', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    let stops = 0;
    const result = await runOwnerSystemdStop(
      { mode: '--inspect-only', expectedOwnerHead: f.sha, checkout: f.checkout },
      deps(f.checkout, {
        stop: async () => {
          stops++;
        },
      }),
    );
    assert.equal(result.status, 'owner-systemd-stop-inspect-only');
    assert.equal(result.supervisorPid, PID);
    assert.equal(result.supervisorStartTicks, TICKS);
    assert.equal(result.stopRequested, false);
    assert.equal(result.stopVerified, false);
    assert.equal(result.servicesRestarted, false);
    assert.equal(result.endToEndVerified, false);
    assert.equal(stops, 0);
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('stale owner SHA or operator PID/birthtime approval cannot stop user service', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    let stops = 0;
    const injected = deps(f.checkout, {
      stop: async () => {
        stops++;
      },
    });
    for (const opts of [
      { expectedOwnerHead: SHA, pid: PID, startTicks: TICKS },
      { expectedOwnerHead: f.sha, pid: PID + 1, startTicks: TICKS },
      { expectedOwnerHead: f.sha, pid: PID, startTicks: '1' },
    ]) {
      await assert.rejects(() =>
        runOwnerSystemdStop(
          {
            mode: '--confirm-owner-systemd-stop',
            checkout: f.checkout,
            ...opts,
          },
          injected,
        ),
      );
    }
    assert.equal(stops, 0);
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('confirmed owner stop calls only one bounded unit stop, then verifies inactive and no children', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    let stops = 0;
    const result = await runOwnerSystemdStop(
      {
        mode: '--confirm-owner-systemd-stop',
        expectedOwnerHead: f.sha,
        checkout: f.checkout,
        pid: PID,
        startTicks: TICKS,
      },
      deps(f.checkout, {
        stop: async () => {
          stops++;
        },
      }),
    );
    assert.equal(stops, 1);
    assert.equal(result.status, 'owner-systemd-stop-verified');
    assert.equal(result.stopVerified, true);
    assert.equal(result.sourceMutated, false);
    assert.equal(result.productionAuditMutated, false);
    assert.equal(result.servicesRestarted, false);
    assert.equal(result.endToEndVerified, false);
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('changed unit PID or supervisor birthtime before stop rejects without side effects', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    let read = 0;
    let stops = 0;
    const injected = deps(f.checkout, {
      readLive: async () => activeUnit(f.checkout, ++read > 4 ? PID + 1 : PID),
      stop: async () => {
        stops++;
      },
    });
    await assert.rejects(() =>
      runOwnerSystemdStop(
        {
          mode: '--confirm-owner-systemd-stop',
          expectedOwnerHead: f.sha,
          checkout: f.checkout,
          pid: PID,
          startTicks: TICKS,
        },
        injected,
      ),
    );
    assert.equal(stops, 0);

    let inspected = 0;
    await assert.rejects(() =>
      runOwnerSystemdStop(
        {
          mode: '--confirm-owner-systemd-stop',
          expectedOwnerHead: f.sha,
          checkout: f.checkout,
          pid: PID,
          startTicks: TICKS,
        },
        deps(f.checkout, {
          inspect: async () => ({
            ...identity,
            startTicks: ++inspected > 4 ? '215' : TICKS,
          }),
          stop: async () => {
            stops++;
          },
        }),
      ),
    );
    assert.equal(stops, 0);
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('ambiguous stop, active child, busy port or foreign post-state never claim success', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    const opts = {
      mode: '--confirm-owner-systemd-stop',
      expectedOwnerHead: f.sha,
      checkout: f.checkout,
      pid: PID,
      startTicks: TICKS,
    };
    for (const overrides of [
      {
        stop: async () => {
          throw new Error('lost systemd reply');
        },
      },
      {
        stop: async () => {},
        readStopped: async () => parseStoppedUserUnit(stoppedLines('/tmp/foreign')),
      },
      { stop: async () => {}, scan: async () => ({ status: 'unknown', totalBlocking: 1 }) },
      { stop: async () => {}, checkPorts: async () => false },
    ])
      await assert.rejects(() => runOwnerSystemdStop(opts, deps(f.checkout, overrides)));
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('untrusted primary Git origin fails before any service mutation', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    git(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/foreign/repo.git');
    let stops = 0;
    await assert.rejects(() =>
      runOwnerSystemdStop(
        {
          mode: '--confirm-owner-systemd-stop',
          expectedOwnerHead: f.sha,
          checkout: f.checkout,
          pid: PID,
          startTicks: TICKS,
        },
        deps(f.checkout, {
          stop: async () => {
            stops++;
          },
        }),
      ),
    );
    assert.equal(stops, 0);
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});
