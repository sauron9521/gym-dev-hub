import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRuntimeArgs,
  parseCurrentMainArgs,
  inspectCurrentMainRuntime,
  parseUserUnitShow,
  inspectInstalledRuntime,
} from './launch-systemd-runtime-preflight.mjs';

const PIN = 'a'.repeat(40);
const CHECKOUT = '/home/owner/Projects/gym-dev-hub';
function show(path = CHECKOUT, pid = 1234) {
  return [
    'Id=gym-dev-hub-operator.service',
    'LoadState=loaded',
    'ActiveState=active',
    'SubState=running',
    'UnitFileState=enabled',
    'MainPID=' + pid,
    'WorkingDirectory=' + path,
    '',
  ].join('\n');
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
  assert.equal(r.status, 0, 'fixture Git operation');
  return r.stdout.trim();
}
async function fixture() {
  const checkout = await mkdtemp(join(tmpdir(), 'hub-systemd-runtime-'));
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fixture');
  git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
  await writeFile(join(checkout, 'README.md'), 'test only\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'fixture');
  return { checkout, sha: git(checkout, 'rev-parse', 'HEAD') };
}
function unitFor(checkout, pid = 1234) {
  return parseUserUnitShow(show(checkout, pid));
}
const identity = {
  status: 'exact-operator-supervisor-verified',
  startTicks: '1234567',
  processOwnerVerified: true,
  scriptIdentityVerified: true,
};

test('strict CLI: check-only, external SHA and absolute owner checkout only', () => {
  assert.deepEqual(
    parseRuntimeArgs(['--check-only', '--expected-main=' + PIN, '--operator-checkout=' + CHECKOUT]),
    { expectedMain: PIN, checkout: CHECKOUT },
  );
  for (const bad of [
    [],
    ['--run', '--expected-main=' + PIN, '--operator-checkout=' + CHECKOUT],
    ['--check-only', '--expected-main=main', '--operator-checkout=' + CHECKOUT],
    ['--check-only', '--expected-main=' + PIN, '--operator-checkout=/tmp/../danger'],
    ['--check-only', '--expected-main=' + PIN, '--operator-checkout=' + CHECKOUT, '--restart'],
  ])
    assert.throws(() => parseRuntimeArgs(bad));
});

test('strict unit parser rejects forged service, duplicate, injected and missing fields', () => {
  const expected = parseUserUnitShow(show());
  assert.equal(expected.pid, 1234);
  assert.equal(expected.checkout, CHECKOUT);
  for (const payload of [
    show().replace('Id=gym-dev-hub-operator.service', 'Id=other.service'),
    show() + 'MainPID=2222\n',
    show().replace('MainPID=1234', 'MainPID=0'),
    show().replace('MainPID=1234', 'MainPID=abc'),
    show().replace('WorkingDirectory=' + CHECKOUT, 'WorkingDirectory=/tmp/../tmp'),
    show().replace('UnitFileState=enabled\n', ''),
    show() + 'Environment=SECRET_SHOULD_NOT_BE_READ\n',
  ])
    assert.throws(() => parseUserUnitShow(payload));
});

test('current owner source and exact stable supervisor are metadata-consistent, never E2E', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    let checks = 0;
    const result = await inspectInstalledRuntime(
      { expectedMain: f.sha, checkout: f.checkout },
      {
        readUnit: async () => unitFor(f.checkout),
        inspectProcess: async () => {
          checks++;
          return identity;
        },
      },
    );
    assert.equal(result.status, 'source-and-process-metadata-consistent');
    assert.equal(result.liveSupervisorIdentityVerified, true);
    assert.equal(checks, 2);
    assert.equal(result.liveRuntimeVersionVerified, false);
    assert.equal(result.approvedForOperatorGrants, false);
    assert.equal(result.endToEndVerified, false);
    assert.equal(result.servicesRestarted, false);
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('stale main is blocked even while an exact Hub supervisor is active', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    const result = await inspectInstalledRuntime(
      { expectedMain: PIN, checkout: f.checkout },
      { readUnit: async () => unitFor(f.checkout), inspectProcess: async () => identity },
    );
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.reasons, ['owner-primary-behind-pinned-main']);
    assert.equal(result.approvedForOperatorGrants, false);
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('foreign unit checkout, changed PID and process identity all fail closed', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    const foreign = await inspectInstalledRuntime(
      { expectedMain: f.sha, checkout: f.checkout },
      {
        readUnit: async () => unitFor('/tmp/foreign'),
        inspectProcess: async () => {
          throw new Error('must not inspect foreign process');
        },
      },
    );
    assert.ok(foreign.reasons.includes('user-unit-points-at-foreign-checkout'));

    let count = 0;
    const changed = await inspectInstalledRuntime(
      { expectedMain: f.sha, checkout: f.checkout },
      {
        readUnit: async () => unitFor(f.checkout, ++count === 1 ? 1234 : 2222),
        inspectProcess: async () => identity,
      },
    );
    assert.ok(changed.reasons.includes('user-unit-changed-during-inspection'));

    const raced = await inspectInstalledRuntime(
      { expectedMain: f.sha, checkout: f.checkout },
      {
        readUnit: async () => unitFor(f.checkout),
        inspectProcess: async () => ({
          ...identity,
          startTicks: ++count === 3 ? '1234567' : '7654321',
        }),
      },
    );
    assert.ok(raced.reasons.includes('operator-process-changed-during-inspection'));
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('untrusted Git remote is never treated as current operator source', async () => {
  if (process.platform !== 'linux') return;
  const f = await fixture();
  try {
    git(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/foreign/repo.git');
    await assert.rejects(
      () =>
        inspectInstalledRuntime(
          { expectedMain: f.sha, checkout: f.checkout },
          { readUnit: async () => unitFor(f.checkout), inspectProcess: async () => identity },
        ),
      /trusted physical owner/,
    );
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('current GitHub main CLI is read-only, two-argument exact and never accepts a stale caller SHA', () => {
  assert.deepEqual(
    parseCurrentMainArgs(['--check-current-github-main', '--operator-checkout=' + CHECKOUT]),
    { checkout: CHECKOUT },
  );
  for (const args of [
    [],
    ['--check-current-github-main', '--operator-checkout=/tmp/../tmp'],
    ['--check-current-github-main', '--operator-checkout=' + CHECKOUT, '--approve'],
    ['--check-current-github-main', '--expected-main=' + PIN, '--operator-checkout=' + CHECKOUT],
    ['--confirm-owner-golden-smoke', '--operator-checkout=' + CHECKOUT],
  ])
    assert.throws(() => parseCurrentMainArgs(args));
});

test('live current-main read-only gate blocks stale HEAD despite valid running systemd supervisor', async () => {
  const f = await fixture();
  try {
    let remoteReads = 0;
    const report = await inspectCurrentMainRuntime(
      { checkout: f.checkout },
      {
        currentMain: async () => {
          remoteReads++;
          return PIN;
        },
        inspect: (request) =>
          inspectInstalledRuntime(request, {
            readUnit: async () => unitFor(f.checkout),
            inspectProcess: async () => identity,
          }),
      },
    );
    assert.equal(remoteReads, 2);
    assert.equal(report.status, 'blocked');
    assert.ok(report.reasons.includes('owner-primary-behind-advertised-github-main'));
    assert.ok(report.reasons.includes('owner-primary-behind-pinned-main'));
    assert.equal(report.liveSupervisorIdentityVerified, true);
    assert.equal(report.mayConsiderSeparateOwnerGoldenAuthorization, false);
    assert.equal(report.productionGrantIssued, false);
    assert.equal(report.dockerExecuted, false);
    assert.equal(report.draftPrCreated, false);
    assert.equal(report.endToEndVerified, false);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.sha);
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('exact matching GitHub main and stable systemd produce metadata-only review, never E2E authorization', async () => {
  const f = await fixture();
  try {
    let probes = 0;
    const r = await inspectCurrentMainRuntime(
      { checkout: f.checkout },
      {
        currentMain: async () => {
          probes++;
          return f.sha;
        },
        inspect: (request) =>
          inspectInstalledRuntime(request, {
            readUnit: async () => unitFor(f.checkout),
            inspectProcess: async () => identity,
          }),
      },
    );
    assert.equal(probes, 2);
    assert.equal(r.status, 'current-main-runtime-metadata-consistent-only');
    assert.equal(r.checkedLiveGitHubMainTwice, true);
    assert.equal(r.mayConsiderSeparateOwnerGoldenAuthorization, true);
    assert.equal(r.liveRuntimeVersionVerified, false);
    assert.equal(r.approvedForOperatorGrants, false);
    assert.equal(r.endToEndVerified, false);
    assert.equal(r.sourceMutated, false);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.sha);
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('moving GitHub main during current-main preflight aborts without falsely marking ready', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    await assert.rejects(
      () =>
        inspectCurrentMainRuntime(
          { checkout: f.checkout },
          {
            currentMain: async () => (++calls === 1 ? f.sha : PIN),
            inspect: (request) =>
              inspectInstalledRuntime(request, {
                readUnit: async () => unitFor(f.checkout),
                inspectProcess: async () => identity,
              }),
          },
        ),
      /GitHub main moved/,
    );
    assert.equal(calls, 2);
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});

test('network unavailable, malformed advertisement and forged runtime receipt fail closed', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () =>
        inspectCurrentMainRuntime(
          { checkout: f.checkout },
          {
            currentMain: async () => {
              throw new Error('offline');
            },
          },
        ),
      /offline/,
    );
    await assert.rejects(
      () =>
        inspectCurrentMainRuntime(
          { checkout: f.checkout },
          {
            currentMain: async () => 'main',
          },
        ),
      /Invalid advertised/,
    );
    await assert.rejects(
      () =>
        inspectCurrentMainRuntime(
          { checkout: f.checkout },
          {
            currentMain: async () => f.sha,
            inspect: async () => ({
              status: 'source-and-process-metadata-consistent',
              reasons: [],
            }),
          },
        ),
      /Untrusted runtime metadata/,
    );
  } finally {
    await rm(f.checkout, { recursive: true, force: true });
  }
});
