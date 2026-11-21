/** Durable metadata-only commit audit and per-plan exclusive file lock. */
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const MAX_BYTES = 1024 * 1024;
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const journalSchema = z.strictObject({
  at: z.iso.datetime(),
  event: z.enum(['issued', 'attempted', 'committed', 'rejected']),
  grantId: z.uuid(),
  runId: z.uuid().nullable(),
  sessionId: z.uuid(),
  planId: z.uuid(),
  candidateSha256: hash,
  sourceCommit: sha,
  filePathSha256: hash,
  subjectSha256: hash,
  commitSha: sha.optional(),
});
export type CommitAuditRecord = z.infer<typeof journalSchema>;
export type CommitAuditEvent = CommitAuditRecord['event'];
export type CommitAuditIdentity = Omit<CommitAuditRecord, 'event' | 'at' | 'commitSha'>;

function privateDir(): string {
  return resolve(
    process.env.DEV_HUB_COMMIT_STATE_DIR ?? resolve(process.cwd(), '.local', 'commit-write'),
  );
}

export async function checkedCommitDirectory(): Promise<string> {
  const dir = privateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const [st, actual] = await Promise.all([lstat(dir), realpath(dir)]);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    actual !== dir ||
    (process.platform !== 'win32' && (st.mode & 0o077) !== 0)
  ) {
    throw new Error('Unsafe Git commit audit directory');
  }
  return dir;
}

export async function commitAudit(
  event: CommitAuditEvent,
  data: CommitAuditIdentity,
  commitSha?: string,
): Promise<void> {
  const dir = await checkedCommitDirectory();
  const file = join(dir, 'audit.jsonl');
  const st = await lstat(file).catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? null : Promise.reject(error),
  );
  if (
    st &&
    (!st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      (process.platform !== 'win32' && (st.mode & 0o077) !== 0))
  ) {
    throw new Error('Unsafe Git commit audit');
  }
  const entry = journalSchema.parse({
    at: new Date().toISOString(),
    event,
    ...data,
    ...(commitSha ? { commitSha } : {}),
  });
  const encoded = JSON.stringify(entry) + '\n';
  if (Buffer.byteLength(encoded) > 1024) throw new Error('Oversized Git commit audit entry');
  const fd = await open(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const check = await fd.stat();
    if (
      !check.isFile() ||
      check.nlink !== 1 ||
      check.size + Buffer.byteLength(encoded) > MAX_BYTES ||
      (process.platform !== 'win32' && (check.mode & 0o077) !== 0)
    ) {
      throw new Error('Git commit audit full or unsafe');
    }
    await fd.writeFile(encoded);
    await fd.sync();
  } finally {
    await fd.close();
  }
}

export interface CommitLock {
  readonly root: string;
  release(): Promise<void>;
}

/**
 * A crash leaves this lock behind. Do not automatically clean or retry it:
 * after a ref update, audit/index status can be indeterminate.
 */
export async function acquireCommitLock(planId: string): Promise<CommitLock> {
  if (!z.uuid().safeParse(planId).success) throw new Error('Invalid commit plan ID');
  const root = await checkedCommitDirectory();
  const path = join(root, planId + '.lock');
  const fd = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const token = randomUUID();
  let inode: { dev: number; ino: number };
  try {
    await fd.writeFile(
      JSON.stringify({
        tokenHash: createHash('sha256').update(token).digest('hex'),
        planId,
        at: new Date().toISOString(),
        pid: process.pid,
      }) + '\n',
    );
    await fd.sync();
    const stat = await fd.stat();
    inode = { dev: stat.dev, ino: stat.ino };
  } finally {
    await fd.close();
  }
  return {
    root,
    async release(): Promise<void> {
      const state = await lstat(path);
      if (
        !state.isFile() ||
        state.isSymbolicLink() ||
        state.nlink !== 1 ||
        state.dev !== inode.dev ||
        state.ino !== inode.ino
      ) {
        throw new Error('Commit lock changed; manual inspection required');
      }
      await unlink(path);
    },
  };
}
