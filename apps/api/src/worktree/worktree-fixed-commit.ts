/**
 * Fixed, one-file Git plumbing; no arbitrary commands, shell, hooks,
 * configured attributes filters or regular Git index staging.
 *
 * Writes only an exact approved raw blob, one tree and one commit object,
 * then CAS-updates the dedicated worktree branch. Main/remote refs are
 * never selected. A separate temporary index preserves the real index
 * until the ref has moved; after CAS, the index is synchronized to HEAD.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SHA = /^[a-f0-9]{40,64}$/;
const BRANCH = /^devhub\/task-[0-9a-f]{32}$/;
const MAX_OUTPUT = 32 * 1024;
const MAX_FILE = 12 * 1024;
const GIT_TIMEOUT = 20_000;

export type FixedCommitIdentity = {
  name: string;
  email: string;
};
export type FixedCommitInput = {
  worktree: string;
  branch: string;
  baseSha: string;
  path: string;
  proposedSha256: string;
  subject: string;
  identity: FixedCommitIdentity;
  temporaryRoot: string;
};
export type FixedCommitReceipt = {
  commitSha: string;
  parentSha: string;
  treeSha: string;
  blobSha: string;
  branch: string;
  filePathSha256: string;
  worktreeClean: true;
  refUpdated: true;
};

export function configuredCommitIdentity(): FixedCommitIdentity {
  const name = process.env.DEV_HUB_COMMIT_AUTHOR_NAME;
  const email = process.env.DEV_HUB_COMMIT_AUTHOR_EMAIL;
  if (
    !name ||
    !email ||
    name.length > 80 ||
    name !== name.trim() ||
    !name.trim() ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._'()-]*$/u.test(name) ||
    email.length > 150 ||
    !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)
  ) {
    throw new Error('Configure a trusted explicit Git commit author name and email');
  }
  return { name, email };
}

function safeEnv(indexFile: string | null, identity: FixedCommitIdentity): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_PAGER = 'cat';
  env.GIT_AUTHOR_NAME = identity.name;
  env.GIT_AUTHOR_EMAIL = identity.email;
  env.GIT_COMMITTER_NAME = identity.name;
  env.GIT_COMMITTER_EMAIL = identity.email;
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  return env;
}

export async function fixedGit(
  cwd: string,
  args: readonly string[],
  identity: FixedCommitIdentity,
  indexFile: string | null = null,
  input?: Buffer,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=.devhub-disabled-hooks',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        '-C',
        cwd,
        ...args,
      ],
      {
        shell: false,
        windowsHide: true,
        env: safeEnv(indexFile, identity),
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      },
    );
    let out = Buffer.alloc(0);
    let errBytes = 0;
    let stopped = false;
    let done = false;
    const abort = () => {
      stopped = true;
      child.kill();
    };
    const timer = setTimeout(abort, GIT_TIMEOUT);
    child.stdout?.on('data', (chunk: Buffer) => {
      out = Buffer.concat([out, chunk]);
      if (out.length > MAX_OUTPUT) abort();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > MAX_OUTPUT) abort();
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(!stopped && code === 0));
    if (input && child.stdin) {
      child.stdin.on('error', () => finish(false));
      child.stdin.end(input);
    }
    function finish(ok: boolean) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ok) resolveOutput(out.toString('utf8').trim());
      else reject(new Error('Fixed local Git plumbing operation failed or timed out'));
    }
  });
}

/**
 * No normal staging. Only dedicated task branch ref may advance. Caller
 * holds a durable per-plan commit lock and rechecks post-apply Git proof.
 */
export async function fixedOneFileCommit(
  input: FixedCommitInput,
  verifyImmediatelyBeforeCAS: () => Promise<void>,
  markRefAdvanced: () => void,
): Promise<FixedCommitReceipt> {
  if (
    !BRANCH.test(input.branch) ||
    !SHA.test(input.baseSha) ||
    !/^[a-f0-9]{64}$/.test(input.proposedSha256) ||
    input.path.length > 160 ||
    !(input.path.startsWith('apps/api/src/') || input.path.startsWith('apps/web/src/')) ||
    input.path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part === '.git') ||
    /[\r\n\0\\]/.test(input.path) ||
    input.subject.length < 10 ||
    input.subject.length > 72 ||
    /[\r\n\0]/.test(input.subject)
  ) {
    throw new Error('Unsupported one-file Git commit request');
  }
  const actual = await realpath(input.worktree);
  const st = await lstat(actual);
  if (actual !== resolve(input.worktree) || !st.isDirectory() || st.isSymbolicLink()) {
    throw new Error('Noncanonical or redirected worktree');
  }
  const head = await fixedGit(actual, ['rev-parse', '--verify', 'HEAD^{commit}'], input.identity);
  const symbolic = await fixedGit(actual, ['symbolic-ref', '-q', 'HEAD'], input.identity);
  if (
    head !== input.baseSha ||
    symbolic !== 'refs/heads/' + input.branch ||
    input.branch === 'main'
  ) {
    throw new Error('Git HEAD/ref changed or is not a dedicated task branch');
  }
  await fixedGit(actual, ['diff', '--cached', '--quiet', 'HEAD', '--'], input.identity);
  const currentEntry = await fixedGit(
    actual,
    ['ls-files', '--stage', '--', input.path],
    input.identity,
  );
  if (
    !/^100644 [a-f0-9]{40,64} 0\t[^\r\n]+$/.test(currentEntry) ||
    !currentEntry.endsWith('\t' + input.path)
  ) {
    throw new Error('Approved file is not one regular tracked non-executable Git blob');
  }
  const file = join(actual, ...input.path.split('/'));
  const before = await lstat(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > MAX_FILE
  )
    throw new Error('Unsafe changed Git file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.size !== before.size ||
      stat.nlink !== 1
    ) {
      throw new Error('Changed source identity during commit');
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (createHash('sha256').update(bytes).digest('hex') !== input.proposedSha256) {
    throw new Error('Approved postimage bytes changed');
  }
  const temp = await mkdtemp(join(input.temporaryRoot, '.index-'));
  const index = join(temp, 'git-index');
  try {
    const blob = await fixedGit(
      actual,
      ['hash-object', '-w', '--no-filters', '--stdin'],
      input.identity,
      null,
      bytes,
    );
    if (!SHA.test(blob)) throw new Error('New Git blob has invalid SHA');
    await fixedGit(actual, ['read-tree', input.baseSha], input.identity, index);
    await fixedGit(
      actual,
      ['update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + input.path],
      input.identity,
      index,
    );
    const tree = await fixedGit(actual, ['write-tree'], input.identity, index);
    if (!SHA.test(tree)) throw new Error('New tree has invalid SHA');
    const changed = await fixedGit(
      actual,
      ['diff-tree', '--no-commit-id', '--name-only', '-r', input.baseSha, tree],
      input.identity,
      index,
    );
    if (changed !== input.path) throw new Error('More than one changed Git file in candidate');
    const committedBlob = await fixedGit(
      actual,
      ['ls-tree', tree, '--', input.path],
      input.identity,
      index,
    );
    if (committedBlob !== '100644 blob ' + blob + '\t' + input.path) {
      throw new Error('Git tree differs from approved postimage');
    }
    const commit = await fixedGit(
      actual,
      ['commit-tree', tree, '-p', input.baseSha, '-m', input.subject],
      input.identity,
      index,
    );
    if (!SHA.test(commit)) throw new Error('New commit has invalid SHA');
    // Last possible full Git/diff/check-audit revalidation before ref write.
    await verifyImmediatelyBeforeCAS();
    if (
      (await fixedGit(actual, ['rev-parse', '--verify', 'HEAD^{commit}'], input.identity)) !==
        input.baseSha ||
      (await fixedGit(actual, ['symbolic-ref', '-q', 'HEAD'], input.identity)) !==
        'refs/heads/' + input.branch
    )
      throw new Error('Branch changed before CAS');
    // Compare-and-swap prevents overwriting any intervening branch changes.
    await fixedGit(
      actual,
      ['update-ref', 'refs/heads/' + input.branch, commit, input.baseSha],
      input.identity,
    );
    markRefAdvanced();
    // HEAD moved, but temporary index left the real index intact until now.
    await fixedGit(actual, ['read-tree', '--reset', 'HEAD'], input.identity);
    const finalHead = await fixedGit(
      actual,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      input.identity,
    );
    const subject = await fixedGit(actual, ['show', '-s', '--format=%s', 'HEAD'], input.identity);
    if (finalHead !== commit || subject !== input.subject) {
      throw new Error('Commit metadata changed after CAS');
    }
    await fixedGit(actual, ['diff', '--quiet', 'HEAD', '--'], input.identity);
    await fixedGit(actual, ['diff', '--cached', '--quiet', 'HEAD', '--'], input.identity);
    return {
      commitSha: commit,
      parentSha: input.baseSha,
      treeSha: tree,
      blobSha: blob,
      branch: input.branch,
      filePathSha256: createHash('sha256').update(input.path).digest('hex'),
      worktreeClean: true,
      refUpdated: true,
    };
  } finally {
    // Failure after CAS may leave live ref moved but local index unsynchronized;
    // caller retains the audit lock and reports state UNKNOWN for manual repair.
    // Any cleanup failure is an uncertain outcome after CAS; caller
    // retains the per-plan lock for manual inspection.
    await rm(temp, { recursive: true, force: true });
  }
}
