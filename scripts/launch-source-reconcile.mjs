/**
 * Read-only local source reconciliation preflight (#106).
 *
 * No fetch/checkout/reset/clean/merge/commit, no secret or .env file reads,
 * and no working-tree file content reads. A green preflight NEVER authorizes a Git write or restart.
 * The owner must separately back up and explicitly perform the fast-forward.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRUSTED_ORIGINS = Object.freeze([
  'git@github.com:sauron9521/gym-dev-hub.git',
  'https://github.com/sauron9521/gym-dev-hub.git',
]);
const PRESERVED_PATHS = Object.freeze(['apps/api/.env', 'apps/api/.local', '.worktrees']);
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

/** Compare paths without case transformations; directory entries end in '/'. */
export function collides(a, b) {
  const left = a.replace(/\\/g, '/');
  const right = b.replace(/\\/g, '/');
  if (left === right) return true;
  if (left.endsWith('/')) return right.startsWith(left);
  if (right.endsWith('/')) return left.startsWith(right);
  return false;
}

/** Git porcelain v1 NUL entries; renamed files fail closed instead of guessing. */
export function parseStatus(raw) {
  const result = { tracked: [], untracked: [], unsafeRenames: false, unsafeIndex: false };
  const entries = raw.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4 || entry[2] !== ' ') {
      result.unsafeRenames = true;
      continue;
    }
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code[0] !== ' ' && code !== '??') result.unsafeIndex = true;
    if (code.includes('U') || ['AA', 'DD'].includes(code)) result.unsafeIndex = true;
    if (code.includes('R') || code.includes('C')) {
      result.unsafeRenames = true;
      i++; // porcelain -z rename/copy includes an additional old pathname
      continue;
    }
    if (code === '??') result.untracked.push(path);
    else result.tracked.push(path);
  }
  return result;
}

/** All output is metadata only; intentionally no secret values or env contents. */
export function assessSource({
  originValid,
  onMain,
  localSha,
  targetSha,
  targetAvailable,
  isAncestor,
  changedPaths,
  tracked,
  untracked,
  unsafeRenames,
  unsafeIndex,
  mergeInProgress,
  unsafePrivateSymlinks,
  privateState,
  worktreeCount,
}) {
  const collisions = [
    ...new Set([
      ...tracked.filter((p) => changedPaths.some((f) => collides(p, f))),
      ...untracked.filter((p) => changedPaths.some((f) => collides(p, f))),
    ]),
  ];
  const reasons = [];
  if (!originValid) reasons.push('untrusted-origin');
  if (!onMain) reasons.push('not-on-main');
  if (!SHA.test(localSha) || !SHA.test(targetSha)) reasons.push('invalid-sha');
  if (!targetAvailable) reasons.push('target-commit-not-present-locally');
  if (!isAncestor) reasons.push('not-a-fast-forward');
  if (unsafeRenames || unsafeIndex) reasons.push('staged-or-unresolved-index');
  if (mergeInProgress) reasons.push('merge-or-rebase-in-progress');
  if (unsafePrivateSymlinks) reasons.push('private-state-symlink');
  if (collisions.length) reasons.push('dirty-files-overlap-upstream-changes');
  const upToDate = localSha === targetSha;
  return {
    repository: 'sauron9521/gym-dev-hub',
    localSha,
    targetSha,
    upToDate,
    status: reasons.length ? 'blocked' : upToDate ? 'up-to-date' : 'preflight-passed',
    // No approval, snapshot or write is implied by preflight-passed.
    safeToConsiderOwnerControlledFastForward: reasons.length === 0 && !upToDate,
    reasons,
    trackedChanges: tracked.length,
    trackedPaths: tracked,
    untrackedEntries: untracked.length,
    overlappingPaths: collisions,
    privateStatePresent: Object.fromEntries(
      PRESERVED_PATHS.map((key) => [key, Boolean(privateState[key])]),
    ),
    worktreeCount,
    performedWrite: false,
    backupVerified: false,
    dockerExecutionVerified: false,
    runtimeRestarted: false,
  };
}

function git(root, args, { allowFailure = false } = {}) {
  const p = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    timeout: 15_000,
    maxBuffer: 3 * 1024 * 1024,
  });
  if (p.error || (p.status !== 0 && !allowFailure))
    throw new Error('Local Git inspection failed (redacted)');
  return p;
}

/**
 * Inspect the ACTUAL primary checkout and an externally verified pinned main
 * commit. This never calls network or mutates Git (including FETCH_HEAD).
 */
export function inspectSource(root, expectedSha) {
  if (!SHA.test(expectedSha)) throw new Error('Expected full 40-character lowercase main SHA');
  const absolute = realpathSync(root);
  const gitRoot = git(absolute, ['rev-parse', '--show-toplevel']).stdout.trim();
  if (realpathSync(gitRoot) !== absolute) throw new Error('Expected repository root');
  const origin = git(absolute, ['remote', 'get-url', 'origin']).stdout.trim();
  const originValid = TRUSTED_ORIGINS.includes(origin);
  const branch = git(absolute, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowFailure: true,
  });
  const onMain = branch.status === 0 && branch.stdout.trim() === 'main';
  const localSha = git(absolute, ['rev-parse', 'HEAD']).stdout.trim();
  const object = git(absolute, ['cat-file', '-t', expectedSha], { allowFailure: true });
  const targetAvailable = object.status === 0 && object.stdout.trim() === 'commit';
  const ancestor = targetAvailable
    ? git(absolute, ['merge-base', '--is-ancestor', localSha, expectedSha], {
        allowFailure: true,
      }).status === 0
    : false;
  const status = parseStatus(
    git(absolute, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).stdout,
  );
  const changedPaths = targetAvailable
    ? git(absolute, ['diff', '--no-ext-diff', '--name-only', '-z', localSha, expectedSha])
        .stdout.split('\0')
        .filter(Boolean)
    : [];
  const mergeInProgress = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD'].some(
    (ref) =>
      git(absolute, ['rev-parse', '--quiet', '--verify', ref], { allowFailure: true }).status === 0,
  );
  const worktrees = git(absolute, ['worktree', 'list', '--porcelain']).stdout;
  let unsafePrivateSymlinks = false;
  const privateState = Object.fromEntries(
    PRESERVED_PATHS.map((path) => {
      const full = resolve(absolute, path);
      let present = false;
      try {
        // lstat does not follow a private-state symlink or read its contents.
        const state = lstatSync(full);
        present = true;
        if (state.isSymbolicLink()) unsafePrivateSymlinks = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Private-state metadata unavailable');
      }
      return [path, present];
    }),
  );
  return assessSource({
    originValid,
    onMain,
    localSha,
    targetSha: expectedSha,
    targetAvailable,
    isAncestor: ancestor,
    tracked: status.tracked,
    untracked: status.untracked,
    unsafeRenames: status.unsafeRenames,
    unsafeIndex: status.unsafeIndex,
    mergeInProgress,
    unsafePrivateSymlinks,
    changedPaths,
    privateState,
    worktreeCount: worktrees.split('\n').filter((line) => line.startsWith('worktree ')).length,
  });
}

function parseArgs(argv) {
  let root = ROOT;
  let expectedSha = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = resolve(argv[++i]);
    else if (argv[i] === '--expected-main-sha' && argv[i + 1]) expectedSha = argv[++i];
    else
      throw new Error(
        'Usage: node scripts/launch-source-reconcile.mjs --expected-main-sha <40hex> [--root <trusted Hub checkout>]',
      );
  }
  if (!expectedSha) throw new Error('Missing externally verified main SHA');
  return { root, expectedSha };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { root, expectedSha } = parseArgs(process.argv.slice(2));
    const report = inspectSource(root, expectedSha);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.status === 'blocked') process.exitCode = 2;
  } catch (error) {
    // Do not print exception details: paths and credentials are intentionally redacted.
    process.stderr.write('SOURCE_PREFLIGHT_FAILED: invalid arguments or repository metadata\n');
    process.exitCode = 2;
  }
}
