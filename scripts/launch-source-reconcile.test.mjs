import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessSource, collides, inspectSource, parseStatus } from './launch-source-reconcile.mjs';

const SCRIPT = fileURLToPath(new URL('./launch-source-reconcile.mjs', import.meta.url));
function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, `fixture Git command failed: ${args[0]}`);
  return result.stdout.trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-source-reconcile-'));
  git(root, 'init', '-b', 'main', '-q');
  git(root, 'config', 'user.name', 'Fixture Operator');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'remote', 'add', 'origin', 'git@github.com:sauron9521/gym-dev-hub.git');
  writeFileSync(join(root, 'turbo.json'), '{"old":true}\n');
  writeFileSync(join(root, 'README.md'), 'root\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial commit', '-q');
  const first = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'upstream-main', '-q');
  writeFileSync(join(root, 'new-doc.md'), 'upstream-only\n');
  git(root, 'add', 'new-doc.md');
  git(root, 'commit', '-m', 'upstream new doc', '-q');
  const next = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', 'main', '-q');
  return { root, first, next };
}

test('recognizes only exact path conflicts including untracked directories', () => {
  assert.equal(collides('apps/api/.local/', 'apps/api/.local/journal.json'), true);
  assert.equal(collides('.worktrees/', '.worktrees/another'), true);
  assert.equal(collides('apps/web/next-env.d.ts', 'apps/web/page.ts'), false);
  assert.equal(collides('turbo.json', 'turbo.json'), true);
  assert.equal(collides('apps/api/.env', 'apps/api/.env.example'), false);
  const status = parseStatus(' M turbo.json\0?? .worktrees/\0');
  assert.deepEqual(status, {
    tracked: ['turbo.json'],
    untracked: ['.worktrees/'],
    unsafeRenames: false,
    unsafeIndex: false,
  });
  const renamed = parseStatus('R  new.md\0old.md\0');
  assert.equal(renamed.unsafeRenames, true);
  assert.equal(parseStatus('M  staged.md\\0').unsafeIndex, true);
  assert.equal(parseStatus('UU broken.md\\0').unsafeIndex, true);
});

test('read-only report treats dirty nonoverlap and preserved private paths as safe for REVIEW only', () => {
  const paths = { 'apps/api/.env': true, 'apps/api/.local': true, '.worktrees': true };
  const report = assessSource({
    originValid: true,
    onMain: true,
    localSha: 'a'.repeat(40),
    targetSha: 'b'.repeat(40),
    targetAvailable: true,
    isAncestor: true,
    changedPaths: ['README.md', 'docs/new.md'],
    tracked: ['turbo.json', 'apps/web/next-env.d.ts'],
    untracked: ['.worktrees/'],
    unsafeRenames: false,
    unsafeIndex: false,
    privateState: paths,
    worktreeCount: 42,
  });
  assert.equal(report.status, 'preflight-passed');
  assert.equal(report.safeToConsiderOwnerControlledFastForward, true);
  assert.equal(report.performedWrite, false);
  assert.equal(report.backupVerified, false);
  assert.equal(report.runtimeRestarted, false);
  assert.equal(report.worktreeCount, 42);
  assert.equal(report.onlyKnownOwnerUntracked, true);
  assert.deepEqual(report.privateStatePresent, paths);
});

test('never green-lights overlapping dirty files, symlink-like unknown statuses or diverged SHA', () => {
  const valid = {
    originValid: true,
    onMain: true,
    localSha: 'a'.repeat(40),
    targetSha: 'b'.repeat(40),
    targetAvailable: true,
    isAncestor: true,
    changedPaths: ['turbo.json'],
    tracked: ['turbo.json'],
    untracked: ['.worktrees/'],
    unsafeRenames: false,
    unsafeIndex: false,
    privateState: {},
    worktreeCount: 1,
  };
  const overlap = assessSource(valid);
  assert.equal(overlap.status, 'blocked');
  assert.deepEqual(overlap.overlappingPaths, ['turbo.json']);
  assert.ok(overlap.reasons.includes('dirty-files-overlap-upstream-changes'));
  for (const patch of [
    { originValid: false },
    { onMain: false },
    { targetAvailable: false },
    { isAncestor: false },
    { unsafeRenames: true },
    { unsafeIndex: true },
    { mergeInProgress: true },
    { unsafePrivateSymlinks: true },
    { targetSha: 'bad-sha' },
  ]) {
    const output = assessSource({ ...valid, tracked: [], ...patch });
    assert.equal(output.status, 'blocked');
    assert.equal(output.safeToConsiderOwnerControlledFastForward, false);
  }
});

test('real Git fixture reports safe nonoverlap; does not touch local head or changed file', () => {
  const { root, first, next } = fixture();
  try {
    writeFileSync(join(root, 'turbo.json'), '{"userLocalEdit":true}\n');
    mkdirSync(join(root, '.worktrees'));
    writeFileSync(join(root, '.worktrees', 'precious-local-file'), 'keep');
    mkdirSync(join(root, 'apps', 'api', '.local'), { recursive: true });
    writeFileSync(join(root, 'apps', 'api', '.local', 'journal'), 'private journal');
    const report = inspectSource(root, next);
    assert.equal(report.localSha, first);
    assert.equal(report.targetSha, next);
    assert.equal(report.status, 'preflight-passed');
    assert.equal(report.safeToConsiderOwnerControlledFastForward, true);
    assert.equal(report.worktreeCount, 1);
    assert.equal(report.trackedPaths.includes('turbo.json'), true);
    assert.equal(report.untrackedEntries >= 1, true);
    assert.equal(report.privateStatePresent['apps/api/.local'], true);
    assert.equal(git(root, 'rev-parse', 'HEAD'), first);
    assert.equal(report.performedWrite, false);
    assert.equal(report.backupVerified, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blocks stale/detached or target-missing source without changing Git refs', () => {
  const { root, first, next } = fixture();
  try {
    const missing = inspectSource(root, 'f'.repeat(40));
    assert.equal(missing.status, 'blocked');
    assert.ok(missing.reasons.includes('target-commit-not-present-locally'));
    git(root, 'checkout', 'upstream-main', '-q');
    const other = inspectSource(root, next);
    assert.equal(other.status, 'blocked');
    assert.ok(other.reasons.includes('not-on-main'));
    git(root, 'checkout', 'main', '-q');
    git(root, 'remote', 'set-url', 'origin', 'https://evil.invalid/mimic.git');
    const wrong = inspectSource(root, next);
    assert.ok(wrong.reasons.includes('untrusted-origin'));
    assert.equal(git(root, 'rev-parse', 'HEAD'), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI never accepts unknown write flags or leaks provided token/secret strings', () => {
  const { root, next } = fixture();
  try {
    const secret = 'sensitive-secret-only-in-process-env';
    const processEnv = { ...process.env, DEV_HUB_GITHUB_PUBLISH_TOKEN: secret };
    const ok = spawnSync(process.execPath, [SCRIPT, '--expected-main-sha', next, '--root', root], {
      encoding: 'utf8',
      env: processEnv,
    });
    assert.equal(ok.status, 0);
    const report = JSON.parse(ok.stdout);
    assert.equal(report.status, 'preflight-passed');
    assert.ok(!ok.stdout.includes(secret));
    assert.equal(report.backupVerified, false);
    assert.equal(report.performedWrite, false);
    const bad = spawnSync(
      process.execPath,
      [SCRIPT, '--expected-main-sha', next, '--root', root, '--reset-hard'],
      { encoding: 'utf8', env: processEnv },
    );
    assert.equal(bad.status, 2);
    assert.ok(!bad.stderr.includes(secret));
    assert.ok(!bad.stdout.includes(secret));
    assert.equal(git(root, 'rev-parse', 'HEAD').length, 40);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
