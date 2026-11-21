import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyOperatorCandidate,
  inspectOperatorProcesses,
} from './launch-operator-process-provenance.mjs';

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hub-operator-proc-fixture-'));
  const checkout = join(root, 'repo');
  const procRoot = join(root, 'proc');
  await mkdir(procRoot);
  await mkdir(checkout);
  await mkdir(join(checkout, 'apps', 'api'), { recursive: true });
  await mkdir(join(checkout, 'apps', 'web'), { recursive: true });
  const external = join(root, 'external');
  await mkdir(external);
  return { root, checkout, procRoot, external };
}
async function processEntry(procRoot, pid, cwd, command) {
  const dir = join(procRoot, String(pid));
  await mkdir(dir);
  await symlink(cwd, join(dir, 'cwd'));
  await writeFile(join(dir, 'cmdline'), Buffer.from(command.join('\0') + '\0'));
}

test('classifier covers operator supervisor, API/Web Node and refuses unrelated paths/terminal shells', () => {
  const root = '/home/local/gym-dev-hub';
  assert.equal(
    classifyOperatorCandidate(root, root, ['node', 'scripts/dev-operator.mjs']),
    'operator-node-toolchain',
  );
  assert.equal(
    classifyOperatorCandidate(root, root + '/apps/api', [
      '/usr/bin/node',
      '/home/local/gym-dev-hub/apps/api/dist/main.js',
    ]),
    'operator-node-toolchain',
  );
  assert.equal(
    classifyOperatorCandidate(root, root + '/apps/web', [
      'node',
      '/home/local/gym-dev-hub/apps/web/node_modules/next/dist/bin/next',
      'dev',
    ]),
    'operator-node-toolchain',
  );
  assert.equal(
    classifyOperatorCandidate(root, root, ['bash', '-c', 'pnpm dev:operator']),
    'operator-launch-command',
  );
  assert.equal(classifyOperatorCandidate(root, root, ['bash']), null);
  assert.equal(
    classifyOperatorCandidate(root, '/home/other/repository', ['node', 'dev-operator.mjs']),
    null,
  );
  assert.equal(
    classifyOperatorCandidate(root, root + '/.worktrees/one', ['node', 'server.js']),
    null,
  );
});

test('mock /proc inventory detects real-shaped process metadata with no PID, cwd, command or secrets in output', async () => {
  const f = await createFixture();
  const privateToken = 'PRIVATE_SHOULD_NEVER_BE_RETURNED';
  try {
    await processEntry(f.procRoot, 101001, f.checkout, [
      '/usr/bin/node',
      'scripts/dev-operator.mjs',
      privateToken,
    ]);
    await processEntry(f.procRoot, 101002, join(f.checkout, 'apps/api'), [
      '/usr/bin/node',
      join(f.checkout, 'apps/api/dist/main.js'),
    ]);
    await processEntry(f.procRoot, 101003, join(f.checkout, 'apps/web'), [
      '/usr/bin/node',
      join(f.checkout, 'apps/web/node_modules/next/dist/bin/next'),
    ]);
    await processEntry(f.procRoot, 101004, f.checkout, ['bash', '-lc', 'pnpm dev:operator']);
    await processEntry(f.procRoot, 101005, f.checkout, ['bash']);
    await processEntry(f.procRoot, 101006, f.external, ['/usr/bin/node', 'server.js']);
    const report = await inspectOperatorProcesses(f.checkout, {
      procRoot: f.procRoot,
      uid: process.getuid(),
      selfPid: 999999,
    });
    assert.equal(report.status, 'operator-processes-not-confirmed-stopped');
    assert.equal(report.nodeToolchain, 3);
    assert.equal(report.hubLaunchCommand, 1);
    assert.equal(report.totalBlocking, 4);
    assert.equal(report.signalsSent, false);
    assert.equal(report.originalCheckoutMutated, false);
    assert.doesNotMatch(
      JSON.stringify(report),
      /101001|101002|101003|101004|PRIVATE_SHOULD_NEVER_BE_RETURNED|apps\/api|apps\/web|\/home\//,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('fail-closed on uninspectable same-owner /proc entries but ignore another checkout', async () => {
  const f = await createFixture();
  try {
    await processEntry(f.procRoot, 101010, f.checkout, ['/usr/bin/node', 'app.js']);
    await processEntry(f.procRoot, 101011, f.checkout, ['/usr/bin/node', 'app.js']);
    await writeFile(join(f.procRoot, '101011', 'cmdline'), Buffer.alloc(8193, 1));
    const report = await inspectOperatorProcesses(f.checkout, {
      procRoot: f.procRoot,
      uid: process.getuid(),
      selfPid: 999999,
    });
    assert.equal(report.nodeToolchain, 1);
    assert.equal(report.uninspectableSameOwner, 1);
    assert.equal(report.totalBlocking, 2);
    await rm(join(f.procRoot, '101010'), { recursive: true });
    await rm(join(f.procRoot, '101011'), { recursive: true });
    await processEntry(f.procRoot, 101012, f.external, ['/usr/bin/node', 'foreign.js']);
    const clean = await inspectOperatorProcesses(f.checkout, {
      procRoot: f.procRoot,
      uid: process.getuid(),
      selfPid: 999999,
    });
    assert.equal(clean.totalBlocking, 0);
    assert.equal(clean.status, 'no-known-operator-processes-at-scan-time');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('denied /proc cwd blocks only Hub-linked argv rather than unrelated desktop processes', async () => {
  const f = await createFixture();
  try {
    for (const [pid, arg] of [
      [101020, f.checkout + '/apps/api/dist/main.js'],
      [101021, '/home/unrelated/project/server.js'],
    ]) {
      const entry = join(f.procRoot, String(pid));
      await mkdir(entry);
      // Not a symlink: represents a denied /proc/PID/cwd readlink.
      await writeFile(join(entry, 'cwd'), 'unavailable');
      await writeFile(
        join(entry, 'cmdline'),
        Buffer.from(['/usr/bin/node', arg].join('\0') + '\0'),
      );
    }
    const output = await inspectOperatorProcesses(f.checkout, {
      procRoot: f.procRoot,
      uid: process.getuid(),
      selfPid: 999999,
    });
    assert.equal(output.totalBlocking, 1);
    assert.equal(output.uninspectableSameOwner, 1);
    assert.doesNotMatch(JSON.stringify(output), /101020|101021|\/home\/|main\.js/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
