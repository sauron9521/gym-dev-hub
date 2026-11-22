import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseOwnerMainImportArgs,
  runOwnerMainObjectImport,
} from './launch-owner-main-object-import.mjs';
import { inspectSource } from './launch-source-reconcile.mjs';

const SHA = 'a'.repeat(40);
const CHECKOUT = '/home/owner/Projects/gym-dev-hub';

function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 12_000,
    maxBuffer: 100_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  assert.equal(r.status, 0, 'Fixture Git operation ' + args.slice(0, 2).join(' '));
  return r.stdout.trim();
}

async function fixture() {
  const tmp = await mkdtemp(join(tmpdir(), 'hub-git-object-import-'));
  const bare = join(tmp, 'upstream.git');
  const upstream = join(tmp, 'upstream');
  const checkout = join(tmp, 'owner');
  git(tmp, 'init', '--bare', '-q', '-b', 'main', bare);
  git(tmp, 'clone', '-q', bare, upstream);
  git(upstream, 'config', 'user.name', 'Fixture');
  git(upstream, 'config', 'user.email', 'fixture@example.invalid');
  await mkdir(join(upstream, 'apps/web'), { recursive: true });
  await writeFile(join(upstream, 'apps/web/next-env.d.ts'), '// original\n');
  await writeFile(join(upstream, 'turbo.json'), '{"fixture":true}\n');
  await writeFile(join(upstream, 'README.md'), 'initial\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-q', '-m', 'initial');
  git(upstream, 'push', '-q', 'origin', 'main');
  git(tmp, 'clone', '-q', bare, checkout);
  git(checkout, 'remote', 'set-url', 'origin', 'https://github.com/sauron9521/gym-dev-hub.git');
  const oldSha = git(checkout, 'rev-parse', 'HEAD');
  await writeFile(join(upstream, 'new-doc.md'), 'updated upstream only\n');
  git(upstream, 'add', 'new-doc.md');
  git(upstream, 'commit', '-q', '-m', 'new upstream');
  git(upstream, 'push', '-q', 'origin', 'main');
  const newSha = git(upstream, 'rev-parse', 'HEAD');

  await writeFile(join(checkout, 'apps/web/next-env.d.ts'), '// owner edit\n');
  await writeFile(join(checkout, 'turbo.json'), '{"owner":true}\n');
  await mkdir(join(checkout, '.worktrees'));
  await writeFile(join(checkout, '.worktrees', 'user-file'), 'preserve\n');
  const opts = { checkout, expectedMain: newSha };
  const refs = async () => git(checkout, 'for-each-ref', '--format=%(refname) %(objectname)');
  let imports = 0;
  const deps = {
    remoteMain: async () => newSha,
    refs,
    fetch: async (dir, sha) => {
      assert.equal(dir, checkout);
      assert.equal(sha, newSha);
      imports++;
      git(
        checkout,
        'fetch',
        '--no-write-fetch-head',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-auto-gc',
        '-q',
        bare,
        sha,
      );
    },
  };
  return { tmp, checkout, oldSha, newSha, opts, deps, refs, imports: () => imports };
}

test('CLI accepts only explicit inspect or confirmed import, literal pinned SHA and primary path', () => {
  const check = ['--check-only', '--expected-main=' + SHA, '--operator-checkout=' + CHECKOUT];
  assert.deepEqual(parseOwnerMainImportArgs(check), {
    mode: '--check-only',
    expectedMain: SHA,
    checkout: CHECKOUT,
  });
  assert.equal(
    parseOwnerMainImportArgs(['--confirm-owner-main-object-import', ...check.slice(1)]).mode,
    '--confirm-owner-main-object-import',
  );
  for (const bad of [
    [],
    check.concat('--force'),
    ['--fetch', ...check.slice(1)],
    [check[0], '--expected-main=main', check[2]],
    [check[0], check[1], '--operator-checkout=/tmp/../tmp'],
    ['--confirm-owner-main-object-import', check[1], check[2], '--reset'],
  ])
    assert.throws(() => parseOwnerMainImportArgs(bad));
});

test('read-only preflight verifies remote pin but does not import or update checkout', async () => {
  const f = await fixture();
  try {
    const originalRefs = await f.refs();
    const r = await runOwnerMainObjectImport({ ...f.opts, mode: '--check-only' }, f.deps);
    assert.equal(r.status, 'pinned-main-object-import-preflight');
    assert.equal(r.gitObjectStoreMutated, false);
    assert.equal(r.requiresSeparateOwnerApprovalToImport, true);
    assert.equal(r.endToEndVerified, false);
    assert.equal(f.imports(), 0);
    assert.equal(inspectSource(f.checkout, f.newSha).status, 'blocked');
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.oldSha);
    assert.equal(await f.refs(), originalRefs);
  } finally {
    await rm(f.tmp, { recursive: true, force: true });
  }
});

test('owner import transfers only missing commit objects, keeps HEAD, refs, edits and private directory', async () => {
  const f = await fixture();
  try {
    const originalRefs = await f.refs();
    const done = await runOwnerMainObjectImport(
      {
        ...f.opts,
        mode: '--confirm-owner-main-object-import',
      },
      f.deps,
    );
    assert.equal(done.status, 'pinned-main-object-imported');
    assert.equal(done.gitObjectStoreMutated, true);
    assert.equal(done.ownerCheckoutChanged, false);
    assert.equal(done.refsChanged, false);
    assert.equal(done.backupVerified, false);
    assert.equal(done.requiresSeparateOwnerApprovalForFastForward, true);
    assert.equal(done.endToEndVerified, false);
    assert.equal(f.imports(), 1);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.oldSha);
    assert.equal(await f.refs(), originalRefs);
    const status = inspectSource(f.checkout, f.newSha);
    assert.equal(status.status, 'preflight-passed');
    assert.equal(status.safeToConsiderOwnerControlledFastForward, true);
    assert.deepEqual(status.trackedPaths.slice().sort(), ['apps/web/next-env.d.ts', 'turbo.json']);
    assert.equal(status.onlyKnownOwnerUntracked, true);
    const again = await runOwnerMainObjectImport(
      {
        ...f.opts,
        mode: '--confirm-owner-main-object-import',
      },
      f.deps,
    );
    assert.equal(again.status, 'pinned-main-object-already-available');
    assert.equal(f.imports(), 1);
  } finally {
    await rm(f.tmp, { recursive: true, force: true });
  }
});

test('stale advertised GitHub main never starts an import', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () =>
        runOwnerMainObjectImport(
          {
            ...f.opts,
            mode: '--confirm-owner-main-object-import',
          },
          { ...f.deps, remoteMain: async () => SHA },
        ),
      /exact live advertised/,
    );
    assert.equal(f.imports(), 0);
  } finally {
    await rm(f.tmp, { recursive: true, force: true });
  }
});

test('unexpected untracked file and untrusted origin block import before Git writes', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.checkout, 'unexpected-file'), 'reject\n');
    await assert.rejects(
      () =>
        runOwnerMainObjectImport(
          {
            ...f.opts,
            mode: '--confirm-owner-main-object-import',
          },
          f.deps,
        ),
      /unexpected local changes/,
    );
    assert.equal(f.imports(), 0);
    await rm(join(f.checkout, 'unexpected-file'));
    git(f.checkout, 'remote', 'set-url', 'origin', 'https://example.invalid/other.git');
    await assert.rejects(
      () =>
        runOwnerMainObjectImport(
          {
            ...f.opts,
            mode: '--confirm-owner-main-object-import',
          },
          f.deps,
        ),
      /missing main object/,
    );
    assert.equal(f.imports(), 0);
  } finally {
    await rm(f.tmp, { recursive: true, force: true });
  }
});

test('remote main moves after owner approval, so no object import occurs', async () => {
  const f = await fixture();
  try {
    let probes = 0;
    await assert.rejects(
      () =>
        runOwnerMainObjectImport(
          {
            ...f.opts,
            mode: '--confirm-owner-main-object-import',
          },
          { ...f.deps, remoteMain: async () => (++probes === 1 ? f.newSha : SHA) },
        ),
      /Upstream main moved/,
    );
    assert.equal(f.imports(), 0);
  } finally {
    await rm(f.tmp, { recursive: true, force: true });
  }
});

test('lost fetch result is ambiguous; attempt is never retried automatically', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    await assert.rejects(
      () =>
        runOwnerMainObjectImport(
          {
            ...f.opts,
            mode: '--confirm-owner-main-object-import',
          },
          {
            ...f.deps,
            fetch: async () => {
              calls++;
              throw new Error('lost response');
            },
          },
        ),
      /lost response/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(f.tmp, { recursive: true, force: true });
  }
});

test('ref rewrite as a side effect of fetch is detected, never called successful', async () => {
  const f = await fixture();
  try {
    const refPrior = await f.refs();
    await assert.rejects(
      () =>
        runOwnerMainObjectImport(
          {
            ...f.opts,
            mode: '--confirm-owner-main-object-import',
          },
          {
            ...f.deps,
            fetch: async (dir, sha) => {
              await f.deps.fetch(dir, sha);
              git(f.checkout, 'update-ref', 'refs/heads/foreign', sha);
            },
          },
        ),
      /postconditions inconclusive/,
    );
    assert.notEqual(await f.refs(), refPrior);
  } finally {
    await rm(f.tmp, { recursive: true, force: true });
  }
});
