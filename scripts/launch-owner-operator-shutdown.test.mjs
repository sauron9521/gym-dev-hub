import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir, writeFile, rm, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseShutdownArgs,
  parseSupervisorStat,
  inspectSupervisor,
  runOwnerShutdown,
} from './launch-owner-operator-shutdown.mjs';
import { portsAvailable } from './launch-owner-fast-forward.mjs';

const sha = '7377295';
const ownRepo = '/home/owner/gym-dev-hub';
const PID = 12345;

test('CLI requires explicit verified supervisor PID and separate birthtime for the signal', () => {
  const preview = ['--inspect-only', '--operator-checkout=' + ownRepo, '--supervisor-pid=' + PID];
  const approved = [
    '--confirm-graceful-stop',
    '--operator-checkout=' + ownRepo,
    '--supervisor-pid=' + PID,
    '--expected-start-ticks=' + sha,
  ];
  assert.deepEqual(parseShutdownArgs(preview), {
    mode: '--inspect-only',
    checkout: ownRepo,
    pid: PID,
    startTicks: null,
  });
  assert.deepEqual(parseShutdownArgs(approved), {
    mode: '--confirm-graceful-stop',
    checkout: ownRepo,
    pid: PID,
    startTicks: sha,
  });
  for (const bad of [
    [],
    preview.slice(1),
    approved.slice(0, 3),
    [...preview, '--expected-start-ticks=' + sha],
    [...approved, '--force'],
    ['--confirm-force-kill', ...approved.slice(1)],
    [approved[0], approved[1], '--supervisor-pid=0', approved[3]],
    [approved[0], approved[1], '--supervisor-pid=1', approved[3]],
    [approved[0], approved[1], '--supervisor-pid=12345.6', approved[3]],
    [approved[0], approved[1], approved[2], '--expected-start-ticks=abc'],
    [approved[0], '--operator-checkout=./somewhere', approved[2], approved[3]],
    [approved[0], '--operator-checkout=/tmp/../root', approved[2], approved[3]],
  ])
    assert.throws(() => parseShutdownArgs(bad));
});

test('Linux /proc stat parser pins birthtime and exposes no raw command line', async () => {
  if (process.platform !== 'linux') return;
  const current = await readFile('/proc/self/stat', 'utf8');
  const parsed = parseSupervisorStat(current, process.pid);
  assert.match(parsed.startTicks, /^[0-9]+$/);
  assert.ok(parsed.parentPid > 0);
  assert.match(parsed.state, /^[A-Z]$/);
  assert.throws(() => parseSupervisorStat(current, process.pid + 1));
  assert.throws(() => parseSupervisorStat('12345 (node) S 1 2 3', 12345));
});

async function reservePort() {
  const { createServer } = await import('node:net');
  const sock = createServer();
  await new Promise((done) => sock.listen(0, '127.0.0.1', done));
  const port = sock.address().port;
  await new Promise((done) => sock.close(done));
  return port;
}

async function disposableOperator() {
  const checkout = await mkdtemp(join(tmpdir(), 'gym-shutdown-owner-fixture-'));
  await mkdir(join(checkout, 'scripts'));
  await mkdir(join(checkout, 'apps/api/dist'), { recursive: true });
  const port = await reservePort();
  const apiScript = join(checkout, 'apps/api/dist/main.js');
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    apiScript,
    ["process.on('SIGTERM',()=>process.exit(0));", 'setInterval(()=>{},1000);'].join('\n'),
  );
  await writeFile(
    join(checkout, 'scripts/dev-operator.mjs'),
    [
      "import {spawn} from 'node:child_process';",
      "import {createServer} from 'node:net';",
      "import {join} from 'node:path';",
      "const api=spawn(process.execPath,[join(process.cwd(),'apps/api/dist/main.js')],{cwd:join(process.cwd(),'apps/api'),detached:true,stdio:'ignore'});",
      "const server=createServer(s=>{s.end('TEST_ONLY');});",
      'let stopping=false;',
      "process.on('SIGTERM',()=>{if(stopping)return;stopping=true;server.close();try{process.kill(-api.pid,'SIGTERM');}catch{}api.once('exit',()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();});",
      "server.listen(Number(process.env.TEST_ONLY_PORT),'127.0.0.1',()=>{setTimeout(()=>process.stdout.write('FIXTURE_READY\\n'),180).unref();});",
    ].join('\n'),
  );
  const child = spawn(process.execPath, ['scripts/dev-operator.mjs'], {
    cwd: checkout,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TEST_ONLY_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  await Promise.race([
    new Promise((done, reject) => {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out = (out + chunk.toString('utf8')).slice(-128);
        if (out.includes('FIXTURE_READY')) done();
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Fixture supervisor exited unexpectedly')));
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Fixture start timed out')), 5000),
    ),
  ]);
  return {
    checkout,
    port,
    child,
    isExited: () => exited,
    cleanup: async () => {
      if (!exited) child.kill('SIGTERM');
      await Promise.race([
        new Promise((done) => {
          if (exited) done();
          else child.once('exit', done);
        }),
        new Promise((done) => setTimeout(done, 4500)),
      ]);
      if (!exited && child.pid) child.kill('SIGKILL'); // test fixture child only
      await rm(checkout, { recursive: true, force: true });
    },
  };
}

test('real disposable supervisor inspection exposes only pinned process identity, no signal', async () => {
  if (process.platform !== 'linux') return;
  const f = await disposableOperator();
  try {
    const safe = await runOwnerShutdown({
      mode: '--inspect-only',
      checkout: f.checkout,
      pid: f.child.pid,
    });
    assert.equal(safe.status, 'read-only-supervisor-verified');
    assert.match(safe.startTicks, /^[0-9]+$/);
    assert.equal(safe.signalsSent, false);
    assert.equal(safe.processesStopped, false);
    assert.equal(safe.supervisorVerified, true);
    assert.equal(await portsAvailable([f.port]), false);
    assert.equal(f.isExited(), false);
    assert.doesNotMatch(JSON.stringify(safe), /FIXTURE_READY|dev-operator\.mjs|apps\/api|\/tmp\//);
    const cliArgs = parseShutdownArgs([
      '--inspect-only',
      '--operator-checkout=' + f.checkout,
      '--supervisor-pid=' + f.child.pid,
    ]);
    assert.equal(cliArgs.pid, f.child.pid);
  } finally {
    await f.cleanup();
  }
});

test('denied /proc cwd and exe fallback requires exact, direct child API command', async () => {
  if (process.platform !== 'linux') return;
  const f = await disposableOperator();
  try {
    const denyLinks = async (path) => {
      if (path.endsWith('/cwd') || path.endsWith('/exe'))
        throw Object.assign(new Error('ptrace denied'), { code: 'EACCES' });
      return readlink(path);
    };
    const report = await inspectSupervisor(f.checkout, f.child.pid, { readLink: denyLinks });
    assert.equal(report.status, 'exact-operator-supervisor-verified');
    assert.equal(report.childLinkageVerified, true);
    assert.equal(report.scriptIdentityVerified, true);
  } finally {
    await f.cleanup();
  }
});

test('stale supervisor start ticks cause rejection and never signal a disposable process', async () => {
  if (process.platform !== 'linux') return;
  const f = await disposableOperator();
  try {
    const original = await inspectSupervisor(f.checkout, f.child.pid);
    let signals = 0;
    await assert.rejects(
      runOwnerShutdown({
        mode: '--confirm-graceful-stop',
        checkout: f.checkout,
        pid: f.child.pid,
        startTicks: '1',
        signalProcess: () => {
          signals++;
        },
        ports: [f.port],
      }),
    );
    assert.equal(signals, 0);
    assert.equal(f.isExited(), false);
    assert.equal(original.startTicks === '1', false);
  } finally {
    await f.cleanup();
  }
});

test('actual SIGTERM is sent only to disposable supervisor, and service/child fully exit', async () => {
  if (process.platform !== 'linux') return;
  const f = await disposableOperator();
  try {
    const verified = await inspectSupervisor(f.checkout, f.child.pid);
    const actual = await runOwnerShutdown({
      mode: '--confirm-graceful-stop',
      checkout: f.checkout,
      pid: f.child.pid,
      startTicks: verified.startTicks,
      ports: [f.port],
      timeoutMs: 8000,
      // Probe ONLY this disposable listener; the host may have other,
      // unrelated Hub processes with ptrace-restricted cwd metadata.
      scan: async () => {
        const free = await portsAvailable([f.port]);
        return {
          status: free
            ? 'no-known-operator-processes-at-scan-time'
            : 'operator-processes-not-confirmed-stopped',
          totalBlocking: free ? 0 : 1,
        };
      },
    });
    assert.equal(actual.status, 'graceful-operator-stop-verified');
    assert.equal(actual.signalsSent, true);
    assert.equal(actual.processesStopped, true);
    assert.equal(actual.servicesRestarted, false);
    assert.equal(actual.gitWritesPerformed, false);
    assert.equal(await portsAvailable([f.port]), true);
    assert.equal(f.isExited(), true);
  } finally {
    await f.cleanup();
  }
});

test('foreign or unknown processes never receive a signal', async () => {
  if (process.platform !== 'linux') return;
  const f = await disposableOperator();
  const other = await mkdtemp(join(tmpdir(), 'gym-unrelated-operator-'));
  try {
    await assert.rejects(inspectSupervisor(other, f.child.pid));
    const original = await inspectSupervisor(f.checkout, f.child.pid);
    let signals = 0;
    await assert.rejects(
      runOwnerShutdown({
        mode: '--confirm-graceful-stop',
        checkout: other,
        pid: f.child.pid,
        startTicks: original.startTicks,
        signalProcess: () => {
          signals++;
        },
        ports: [f.port],
      }),
    );
    assert.equal(signals, 0);
    assert.equal(f.isExited(), false);
  } finally {
    await f.cleanup();
    await rm(other, { recursive: true, force: true });
  }
});
