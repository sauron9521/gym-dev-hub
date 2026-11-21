/**
 * Publish the exact locally audited Git commit to a NEW task branch via
 * GitHub's Git Data API. No git push credentials, no force/update-ref API,
 * no user-controlled URLs, no main ref mutations, no shell commands.
 */
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WorktreePlan } from '@gym-dev-hub/contracts';
import { fixedGit, type FixedCommitIdentity } from './worktree-fixed-commit.js';
import { readCommitAudit, auditedCompletedCommit } from './worktree-commit-audit.js';

const HEX40 = /^[a-f0-9]{40}$/;
const TASK_REF = /^devhub\/task-[a-f0-9]{32}$/;
const MAX_FILE = 12 * 1024;
const READ_ONLY_ID: FixedCommitIdentity = {
  name: 'Local Git Inspector',
  email: 'inspector@example.invalid',
};
const SHA256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type VerifiedPublishedCommit = {
  branch: string;
  parentSha: string;
  commitSha: string;
  treeSha: string;
  parentTreeSha: string;
  blobSha: string;
  filePath: string;
  rawContent: Buffer;
  subject: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
};

function isoGitDate(seconds: string, timezone: string): string {
  const sign = timezone[0] === '+' ? 1 : -1;
  const hours = Number(timezone.slice(1, 3));
  const minutes = Number(timezone.slice(3, 5));
  if (hours > 14 || minutes > 59) throw new Error('Unsupported Git commit timezone');
  const unix = Number(seconds);
  const wall = new Date((unix + sign * (hours * 60 + minutes) * 60) * 1000);
  if (!Number.isSafeInteger(unix) || Number.isNaN(wall.valueOf())) {
    throw new Error('Unsupported commit author date');
  }
  return wall.toISOString().slice(0, 19) + timezone.slice(0, 3) + ':' + timezone.slice(3, 5);
}

function parsePerson(line: string): { name: string; email: string; date: string } {
  const match =
    /^(.{1,80}) <([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})> (\d{10}) ([+-]\d{4})$/.exec(
      line,
    );
  if (!match) throw new Error('Unsupported author/committer Git identity');
  return {
    name: match[1]!,
    email: match[2]!,
    date: isoGitDate(match[3]!, match[4]!),
  };
}

/** Only after a completed PR #68 audit; no new Git writes. */
export async function inspectLocalCommitForPush(
  plan: WorktreePlan,
  sessionId: string,
  planId: string,
  expectedSha: string,
): Promise<VerifiedPublishedCommit> {
  if (
    plan.repository !== 'sauron9521/gym-dev-hub' ||
    !TASK_REF.test(plan.proposedBranch) ||
    !HEX40.test(expectedSha) ||
    !plan.baseHeadSha ||
    !HEX40.test(plan.baseHeadSha)
  ) {
    throw new Error('Not an approved isolated Gym Dev Hub task commit');
  }
  const root = resolve(plan.targetPath);
  if ((await realpath(root)) !== root) throw new Error('Redirected worktree path');
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe task worktree');
  const [head, ref, status, parent, tree, parentTree, changed, raw] = await Promise.all([
    fixedGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'], READ_ONLY_ID),
    fixedGit(root, ['symbolic-ref', '-q', 'HEAD'], READ_ONLY_ID),
    fixedGit(root, ['status', '--porcelain', '--untracked-files=all'], READ_ONLY_ID),
    fixedGit(root, ['rev-parse', '--verify', 'HEAD^'], READ_ONLY_ID),
    fixedGit(root, ['rev-parse', '--verify', 'HEAD^{tree}'], READ_ONLY_ID),
    fixedGit(root, ['rev-parse', '--verify', plan.baseHeadSha + '^{tree}'], READ_ONLY_ID),
    fixedGit(
      root,
      ['diff-tree', '--no-commit-id', '--name-only', '-r', plan.baseHeadSha, 'HEAD'],
      READ_ONLY_ID,
    ),
    fixedGit(root, ['cat-file', '-p', 'HEAD'], READ_ONLY_ID),
  ]);
  if (
    head !== expectedSha ||
    ref !== 'refs/heads/' + plan.proposedBranch ||
    parent !== plan.baseHeadSha ||
    status !== '' ||
    !HEX40.test(tree) ||
    !HEX40.test(parentTree) ||
    !changed ||
    changed.includes('\n') ||
    !(changed.startsWith('apps/api/src/') || changed.startsWith('apps/web/src/')) ||
    changed.length > 160 ||
    changed.split('/').some((p) => !p || p === '.' || p === '..' || p === '.git') ||
    /[\\\r\n\0]/.test(changed)
  )
    throw new Error('Unexpected Git tree, branch or changed files');
  const audit = auditedCompletedCommit(await readCommitAudit(), sessionId, planId, expectedSha);
  if (audit.parentSha !== parent || SHA256(changed) !== audit.filePathSha256) {
    throw new Error('Committed file is not bound to the reviewed local audit');
  }
  const parts =
    /^tree ([a-f0-9]{40})\nparent ([a-f0-9]{40})\nauthor ([^\n]+)\ncommitter ([^\n]+)\n\n([^\r\n]{10,72})$/.exec(
      raw,
    );
  if (
    !parts ||
    parts[1] !== tree ||
    parts[2] !== parent ||
    SHA256(parts[5]!) !== audit.subjectSha256
  ) {
    throw new Error('Unsupported or unsigned local Git commit object');
  }
  const path = join(root, ...changed.split('/'));
  const state = await lstat(path);
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    state.size < 1 ||
    state.size > MAX_FILE
  )
    throw new Error('Unsafe published file');
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const current = await fd.stat();
    if (
      !current.isFile() ||
      current.dev !== state.dev ||
      current.ino !== state.ino ||
      current.size !== state.size ||
      current.nlink !== 1
    )
      throw new Error('Published file changed during read');
    bytes = await fd.readFile();
  } finally {
    await fd.close();
  }
  const blob = createHash('sha1')
    .update(Buffer.from('blob ' + bytes.length + '\0', 'utf8'))
    .update(bytes)
    .digest('hex');
  const entry = await fixedGit(root, ['ls-tree', tree, '--', changed], READ_ONLY_ID);
  if (entry !== '100644 blob ' + blob + '\t' + changed) {
    throw new Error('Published Git blob differs from the source file');
  }
  // Check again after reading files, to reject a concurrent local change.
  const [after, afterState] = await Promise.all([
    fixedGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'], READ_ONLY_ID),
    fixedGit(root, ['status', '--porcelain', '--untracked-files=all'], READ_ONLY_ID),
  ]);
  if (after !== expectedSha || afterState) throw new Error('Git changed during publish inspection');
  return {
    branch: plan.proposedBranch,
    commitSha: expectedSha,
    parentSha: parent,
    treeSha: tree,
    parentTreeSha: parentTree,
    blobSha: blob,
    filePath: changed,
    rawContent: bytes,
    subject: parts[5]!,
    author: parsePerson(parts[3]!),
    committer: parsePerson(parts[4]!),
  };
}

type GitHubObject = { sha?: string; ref?: string; object?: { sha?: string } };
const API = 'https://api.github.com/repos/sauron9521/gym-dev-hub';
const JSON_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  'User-Agent': 'gym-dev-hub-local-publish',
};

export class GitHubWriteError extends Error {
  constructor(
    readonly step: string,
    readonly status: number,
  ) {
    super('GitHub publish step failed');
  }
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: object,
): Promise<{ status: number; json: GitHubObject | null }> {
  // Only fixed API root and explicit relative paths provided by our own code.
  if (!path.startsWith('/git/') || path.includes('..') || path.includes('?')) {
    throw new Error('Non-fixed GitHub Git Data API target');
  }
  const response = await fetch(API + path, {
    method,
    headers: { ...JSON_HEADERS, Authorization: 'Bearer ' + token },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(12_000),
    cache: 'no-store',
    redirect: 'error',
  });
  if (response.status === 404 && method === 'GET') return { status: 404, json: null };
  if (response.status !== (method === 'POST' ? 201 : 200)) {
    throw new GitHubWriteError(method + ' ' + path, response.status);
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Unexpected GitHub Git Data API response');
  }
  return { status: response.status, json: value as GitHubObject };
}

function branchPath(branch: string): string {
  if (!TASK_REF.test(branch)) throw new Error('Only a dedicated devhub/task branch is allowed');
  return '/git/ref/heads/' + branch;
}

export async function assertGitHubBranchAbsent(branch: string, token: string): Promise<void> {
  const response = await request('GET', branchPath(branch), token);
  if (response.status !== 404) throw new Error('Remote task branch already exists');
}

/**
 * GitHub's create-ref POST atomically creates only a NEW ref. No force,
 * update-ref/PATCH, remote main, remote hooks, or arbitrary Git push.
 * Unreferenced objects may remain if a step fails before branch creation.
 */
export async function publishExactCommit(
  approved: VerifiedPublishedCommit,
  token: string,
  immediatelyBeforeCreateRef: () => Promise<void>,
  refAttempted: () => void,
): Promise<void> {
  if (
    !TASK_REF.test(approved.branch) ||
    ![
      approved.commitSha,
      approved.parentSha,
      approved.treeSha,
      approved.parentTreeSha,
      approved.blobSha,
    ].every((x) => HEX40.test(x))
  ) {
    throw new Error('Invalid pinned Git object');
  }
  await assertGitHubBranchAbsent(approved.branch, token);
  const base = await request('GET', '/git/commits/' + approved.parentSha, token);
  if (base.json?.sha !== approved.parentSha) throw new Error('Remote Git parent missing');
  const blob = await request('POST', '/git/blobs', token, {
    content: approved.rawContent.toString('base64'),
    encoding: 'base64',
  });
  if (blob.json?.sha !== approved.blobSha) throw new Error('GitHub blob SHA mismatch');
  const tree = await request('POST', '/git/trees', token, {
    base_tree: approved.parentTreeSha,
    tree: [
      {
        path: approved.filePath,
        mode: '100644',
        type: 'blob',
        sha: approved.blobSha,
      },
    ],
  });
  if (tree.json?.sha !== approved.treeSha) throw new Error('GitHub tree SHA mismatch');
  const commit = await request('POST', '/git/commits', token, {
    // `git commit-tree -m` stores a terminal LF. GitHub's Git Data API uses
    // the exact supplied message bytes; omitting LF creates a different SHA.
    message: approved.subject + '\n',
    tree: approved.treeSha,
    parents: [approved.parentSha],
    author: approved.author,
    committer: approved.committer,
  });
  if (commit.json?.sha !== approved.commitSha) throw new Error('GitHub commit SHA mismatch');
  await immediatelyBeforeCreateRef();
  await assertGitHubBranchAbsent(approved.branch, token);
  refAttempted(); // Unknown outcome after a network error: preserve lock.
  const created = await request('POST', '/git/refs', token, {
    ref: 'refs/heads/' + approved.branch,
    sha: approved.commitSha,
  });
  if (
    created.json?.ref !== 'refs/heads/' + approved.branch ||
    created.json?.object?.sha !== approved.commitSha
  ) {
    throw new Error('GitHub created an unexpected ref');
  }
  const confirmed = await request('GET', branchPath(approved.branch), token);
  if (
    confirmed.json?.ref !== 'refs/heads/' + approved.branch ||
    confirmed.json?.object?.sha !== approved.commitSha
  ) {
    throw new Error('GitHub branch creation could not be confirmed');
  }
}
