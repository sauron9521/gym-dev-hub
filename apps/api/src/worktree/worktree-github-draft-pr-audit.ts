/** Metadata-only fsynced local audit for independently authorized Draft PRs. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { checkedCommitDirectory } from './worktree-commit-audit.js';

const record = z.strictObject({
  at: z.iso.datetime(),
  event: z.enum(['issued', 'attempted', 'created', 'rejected']),
  grantId: z.uuid(),
  runId: z.uuid().nullable(),
  sessionId: z.uuid(),
  planId: z.uuid(),
  branch: z.string().regex(/^devhub\/task-[a-f0-9]{32}$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  titleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  prNumber: z.number().int().positive().optional(),
});
export type DraftPrAudit = z.infer<typeof record>;
export type DraftPrAuditIdentity = Omit<DraftPrAudit, 'event' | 'at' | 'prNumber'>;

export async function appendDraftPrAudit(
  event: DraftPrAudit['event'],
  identity: DraftPrAuditIdentity,
  prNumber?: number,
): Promise<void> {
  const dir = await checkedCommitDirectory();
  const file = join(dir, 'github-draft-pr.jsonl');
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
    throw new Error('Unsafe GitHub Draft PR journal');
  }
  const eventLine = record.parse({
    at: new Date().toISOString(),
    event,
    ...identity,
    ...(prNumber === undefined ? {} : { prNumber }),
  });
  if ((event === 'created') !== (prNumber !== undefined)) {
    throw new Error('Confirmed Draft PR needs exact PR number');
  }
  const line = JSON.stringify(eventLine) + '\n';
  if (Buffer.byteLength(line) > 1024) throw new Error('Oversized Draft PR audit record');
  const fd = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size + Buffer.byteLength(line) > 1024 * 1024 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error('GitHub Draft PR journal full or unsafe');
    }
    await fd.writeFile(line);
    await fd.sync();
  } finally {
    await fd.close();
  }
}
