/**
 * Private, bounded, operator-only audit for fixed post-apply Docker checks.
 * Intentionally stores no code, raw logs, local paths, tokens or secrets.
 * The journal is append-only; it is not a tamper-proof external audit log.
 */
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type {
  WorktreePatchCheckHistory,
  WorktreePatchCheckHistoryEntry,
  WorktreePatchCheckRecipe,
} from '@gym-dev-hub/contracts';

const MAX_AUDIT_BYTES = 1024 * 1024;
const MAX_AUDIT_LINE_BYTES = 1200;
const MAX_HISTORY_ITEMS = 30;
const AUTH_TTL_MS = 45_000;
const uuid = z.uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const eventSchema = z.enum(['issued', 'attempted', 'passed', 'rejected', 'cancel-requested']);
const recipeSchema = z.enum([
  'API_FORMAT',
  'API_TYPECHECK',
  'API_TEST',
  'WEB_FORMAT',
  'WEB_TYPECHECK',
  'WEB_TEST',
]);
const recordSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  event: eventSchema,
  grantId: uuid,
  runId: uuid.nullable(),
  sessionId: uuid,
  planId: uuid,
  recipeId: recipeSchema,
  fingerprint,
  sourceCommit: commit,
  filePathSha256: sha,
  sourceSha256: sha,
  proposedSha256: sha,
  durationMs: z.number().int().min(0).max(600_000).optional(),
  stdoutBytes: z.number().int().min(0).max(65_536).optional(),
  stderrBytes: z.number().int().min(0).max(65_536).optional(),
  containerRemoved: z.literal(true).optional(),
  failureKind: z.enum(['failed', 'canceled']).optional(),
});
export type CheckAuditRecord = z.infer<typeof recordSchema>;
export type CheckAuditEvent = CheckAuditRecord['event'];
export type CheckAuditIdentity = Pick<
  CheckAuditRecord,
  | 'sessionId'
  | 'planId'
  | 'recipeId'
  | 'fingerprint'
  | 'sourceCommit'
  | 'sourceSha256'
  | 'proposedSha256'
> & { id: string; filePath: string };
export type CheckAuditOutcome = Pick<
  CheckAuditRecord,
  'durationMs' | 'stdoutBytes' | 'stderrBytes' | 'containerRemoved' | 'failureKind'
>;

function auditDir(): string {
  return resolve(
    process.env.DEV_HUB_PATCH_CHECK_STATE_DIR ?? resolve(process.cwd(), '.local', 'patch-checks'),
  );
}

async function strictAuditDirectory(create: boolean): Promise<string | null> {
  const dir = auditDir();
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  let stat;
  try {
    stat = await lstat(dir);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const canonical = await realpath(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical !== dir ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error('Unsafe patch check audit folder');
  }
  return dir;
}

/** Durability checked before success response; emits fixed metadata only. */
export async function appendPatchCheckAudit(
  event: CheckAuditEvent,
  grant: CheckAuditIdentity,
  runId?: string,
  metrics?: CheckAuditOutcome,
): Promise<void> {
  const dir = await strictAuditDirectory(true);
  if (!dir) throw new Error('Audit directory missing');
  const path = join(dir, 'audit.jsonl');
  const previous = await lstat(path).catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? null : Promise.reject(error),
  );
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)) {
    throw new Error('Unsafe patch check audit file');
  }
  const content = recordSchema.parse({
    at: new Date().toISOString(),
    event,
    grantId: grant.id,
    runId: runId ?? null,
    sessionId: grant.sessionId,
    planId: grant.planId,
    recipeId: grant.recipeId,
    fingerprint: grant.fingerprint,
    sourceCommit: grant.sourceCommit,
    filePathSha256: createHash('sha256').update(grant.filePath).digest('hex'),
    sourceSha256: grant.sourceSha256,
    proposedSha256: grant.proposedSha256,
    ...metrics,
  });
  const encoded = JSON.stringify(content) + '\n';
  if (Buffer.byteLength(encoded) > MAX_AUDIT_LINE_BYTES) {
    throw new Error('Audit record size exceeded');
  }
  const fd = await open(
    path,
    constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size + Buffer.byteLength(encoded) > MAX_AUDIT_BYTES ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error('Unsafe patch check audit log');
    }
    await fd.writeFile(encoded);
    await fd.sync();
  } finally {
    await fd.close();
  }
}

/** Full validation before filtering; no partial or best-effort audit data is returned. */
export async function readPatchCheckAudit(): Promise<CheckAuditRecord[]> {
  const dir = await strictAuditDirectory(false);
  if (!dir) return [];
  const path = join(dir, 'audit.jsonl');
  let previous;
  try {
    previous = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (
    !previous.isFile() ||
    previous.isSymbolicLink() ||
    previous.nlink !== 1 ||
    previous.size > MAX_AUDIT_BYTES ||
    (process.platform !== 'win32' && (previous.mode & 0o077) !== 0)
  ) {
    throw new Error('Unsafe patch check history file');
  }
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let source: string;
  try {
    const info = await fd.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > MAX_AUDIT_BYTES ||
      info.ino !== previous.ino ||
      info.dev !== previous.dev ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    ) {
      throw new Error('Patch check history changed during read');
    }
    source = await fd.readFile({ encoding: 'utf8' });
  } finally {
    await fd.close();
  }
  if (!source) return [];
  if (Buffer.byteLength(source) > MAX_AUDIT_BYTES || !source.endsWith('\n')) {
    throw new Error('Truncated patch check audit');
  }
  const lines = source.slice(0, -1).split('\n');
  return lines.map((line) => {
    if (!line || Buffer.byteLength(line) > MAX_AUDIT_LINE_BYTES) {
      throw new Error('Invalid audit record boundaries');
    }
    return recordSchema.parse(JSON.parse(line) as unknown);
  });
}

type Projection = {
  entry: WorktreePatchCheckHistoryEntry;
  sourceSha256: string;
  fingerprint: string;
  runSeen: boolean;
  cancelRequested: boolean;
  terminal: boolean;
};

/** Read-only projection of historical metadata; does not re-execute any checks. */
export function projectPatchCheckHistory(
  all: readonly CheckAuditRecord[],
  sessionId: string,
  planId: string,
  activeRunId: string | null,
  activeGrantIds: ReadonlySet<string>,
  now = Date.now(),
): WorktreePatchCheckHistory {
  const grants = new Map<string, Projection>();
  for (const record of all) {
    if (record.sessionId !== sessionId || record.planId !== planId) continue;
    let item = grants.get(record.grantId);
    if (record.event === 'issued') {
      if (item || record.runId !== null) throw new Error('Duplicate or invalid audit grant');
      const entry: WorktreePatchCheckHistoryEntry = {
        grantId: record.grantId,
        runId: null,
        recipeId: record.recipeId as WorktreePatchCheckRecipe,
        sourceCommit: record.sourceCommit,
        proposedSha256: record.proposedSha256,
        filePathSha256: record.filePathSha256,
        status: 'expired',
        authorizedAt: record.at,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        stdoutBytes: null,
        stderrBytes: null,
      };
      grants.set(record.grantId, {
        entry,
        sourceSha256: record.sourceSha256,
        fingerprint: record.fingerprint,
        runSeen: false,
        cancelRequested: false,
        terminal: false,
      });
      continue;
    }
    if (
      !item ||
      record.runId === null ||
      item.terminal ||
      item.entry.recipeId !== record.recipeId ||
      item.entry.sourceCommit !== record.sourceCommit ||
      item.entry.proposedSha256 !== record.proposedSha256 ||
      item.entry.filePathSha256 !== record.filePathSha256 ||
      item.sourceSha256 !== record.sourceSha256 ||
      item.fingerprint !== record.fingerprint
    ) {
      throw new Error('Invalid audit event sequence or identity');
    }
    if (record.event === 'attempted') {
      if (item.runSeen) throw new Error('Multiple executions of one-time check');
      item.entry.runId = record.runId;
      item.entry.startedAt = record.at;
      item.runSeen = true;
    } else {
      if (!item.runSeen || item.entry.runId !== record.runId) {
        throw new Error('Unbound patch check result in audit');
      }
      if (record.event === 'cancel-requested') {
        if (item.cancelRequested) throw new Error('Duplicate cancellation audit');
        item.cancelRequested = true;
        item.entry.status = 'cancel-requested';
      } else {
        item.entry.finishedAt = record.at;
        item.entry.status =
          record.event === 'passed'
            ? 'passed'
            : record.failureKind === 'canceled'
              ? 'canceled'
              : 'failed';
        item.entry.durationMs = record.durationMs ?? null;
        item.entry.stdoutBytes = record.stdoutBytes ?? null;
        item.entry.stderrBytes = record.stderrBytes ?? null;
        item.terminal = true;
      }
    }
  }
  const items = [...grants.values()].map(({ entry, runSeen, terminal }) => {
    if (!runSeen) {
      entry.status =
        activeGrantIds.has(entry.grantId) && Date.parse(entry.authorizedAt) + AUTH_TTL_MS > now
          ? 'authorized'
          : 'expired';
    } else if (!terminal && entry.runId !== activeRunId) {
      entry.status = 'interrupted'; // A restart/crash has no proven outcome.
    } else if (!terminal && entry.status !== 'cancel-requested') {
      entry.status = 'running';
    }
    return entry;
  });
  // Never expose more than 30 records and never claim an incomplete log is complete.
  items.reverse();
  return {
    sessionId,
    planId,
    checkedAt: new Date(now).toISOString(),
    items: items.slice(0, MAX_HISTORY_ITEMS),
    total: items.length,
    limited: items.length > MAX_HISTORY_ITEMS,
    readOnly: true,
    rawLogsAvailable: false,
    commandsEnabled: false,
    commitEnabled: false,
    pushEnabled: false,
    mergeEnabled: false,
  };
}
