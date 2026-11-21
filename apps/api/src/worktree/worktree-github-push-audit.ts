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

/** Exact read-only audit replay; absence of terminal success is never success. */
export async function auditedPublishedTaskBranch(
  sessionId: string,
  planId: string,
  commitSha: string,
  branch: string,
): Promise<{ runId: string; parentSha: string }> {
  const dir = await checkedCommitDirectory();
  const file = join(dir, 'github-push.jsonl');
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size <= 0 ||
    stat.size > 1024 * 1024 ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error('Unsafe or empty GitHub publish audit');
  }
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const first = await fd.stat();
    if (
      !first.isFile() ||
      first.ino !== stat.ino ||
      first.dev !== stat.dev ||
      first.size !== stat.size
    )
      throw new Error('GitHub publish audit changed on open');
    const data = await fd.readFile();
    const final = await fd.stat();
    if (
      data.length !== first.size ||
      final.size !== first.size ||
      first.mtimeMs !== final.mtimeMs ||
      first.ctimeMs !== final.ctimeMs ||
      data.at(-1) !== 10
    )
      throw new Error('GitHub publish audit changed/truncated');
    const entries = new TextDecoder('utf-8', { fatal: true })
      .decode(data)
      .slice(0, -1)
      .split('\n')
      .map((line) => {
        if (!line || Buffer.byteLength(line) > 1024) throw new Error('Invalid publish audit row');
        return record.parse(JSON.parse(line) as unknown);
      });
    const grants = new Map<string, GitHubPushAudit[]>();
    for (const entry of entries) {
      const history = grants.get(entry.grantId) ?? [];
      history.push(entry);
      grants.set(entry.grantId, history);
    }
    let matching: GitHubPushAudit | null = null;
    for (const history of grants.values()) {
      const [issued, attempted, finalEvent] = history;
      if (
        !issued ||
        issued.event !== 'issued' ||
        issued.runId !== null ||
        history.length > 3 ||
        (attempted && (attempted.event !== 'attempted' || attempted.runId === null)) ||
        (finalEvent &&
          (!['published', 'rejected'].includes(finalEvent.event) ||
            finalEvent.runId !== attempted?.runId)) ||
        history.some(
          (entry) =>
            entry.sessionId !== issued.sessionId ||
            entry.planId !== issued.planId ||
            entry.commitSha !== issued.commitSha ||
            entry.branch !== issued.branch ||
            entry.parentSha !== issued.parentSha,
        )
      ) {
        throw new Error('Invalid GitHub publish audit transition');
      }
      if (
        finalEvent?.event !== 'published' ||
        finalEvent.sessionId !== sessionId ||
        finalEvent.planId !== planId ||
        finalEvent.commitSha !== commitSha ||
        finalEvent.branch !== branch
      )
        continue;
      if (matching) throw new Error('Ambiguous completed task branch publication');
      matching = finalEvent;
    }
    if (!matching?.runId) throw new Error('No confirmed task branch publication');
    return { runId: matching.runId, parentSha: matching.parentSha };
  } finally {
    await fd.close();
  }
}
