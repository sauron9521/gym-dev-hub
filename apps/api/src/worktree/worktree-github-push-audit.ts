/** Separate local fsynced journal for explicit GitHub task-branch publication. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { checkedCommitDirectory } from './worktree-commit-audit.js';

const record = z.strictObject({
  at: z.iso.datetime(),
  event: z.enum(['issued', 'attempted', 'published', 'rejected']),
  grantId: z.uuid(),
  runId: z.uuid().nullable(),
  sessionId: z.uuid(),
  planId: z.uuid(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string().regex(/^devhub\/task-[a-f0-9]{32}$/),
  parentSha: z.string().regex(/^[a-f0-9]{40}$/),
});
export type GitHubPushAudit = z.infer<typeof record>;
export type GitHubPushAuditIdentity = Omit<GitHubPushAudit, 'at' | 'event'>;

export async function appendGitHubPushAudit(
  event: GitHubPushAudit['event'],
  identity: GitHubPushAuditIdentity,
): Promise<void> {
  const dir = await checkedCommitDirectory();
  const file = join(dir, 'github-push.jsonl');
  const before = await lstat(file).catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? null : Promise.reject(error),
  );
  if (
    before &&
    (!before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (process.platform !== 'win32' && (before.mode & 0o077) !== 0))
  ) {
    throw new Error('Unsafe GitHub publish audit file');
  }
  const entry = record.parse({ at: new Date().toISOString(), event, ...identity });
  const line = JSON.stringify(entry) + '\n';
  if (Buffer.byteLength(line) > 1024) throw new Error('Publish audit row oversized');
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size + Buffer.byteLength(line) > 1024 * 1024 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error('GitHub publish audit full or unsafe');
    }
    await handle.writeFile(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
