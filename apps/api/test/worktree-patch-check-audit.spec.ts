import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendPatchCheckAudit,
  projectPatchCheckHistory,
  readPatchCheckAudit,
} from '../src/worktree/worktree-patch-check-audit.js';

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const OTHER_SESSION = '00000000-0000-4000-8000-000000000891';
const OTHER_PLAN = '00000000-0000-4000-8000-000000000890';
const sourceHash = 'a'.repeat(64);
const postHash = 'b'.repeat(64);
const fingerprint = 'sha256:' + 'c'.repeat(64);
const commit = 'd'.repeat(40);
const identity = (overrides: Record<string, string> = {}) => ({
  id: randomUUID(),
  sessionId: SESSION,
  planId: PLAN,
  recipeId: 'API_TEST' as const,
  fingerprint,
  sourceCommit: commit,
  filePath: 'apps/api/src/main.ts',
  sourceSha256: sourceHash,
  proposedSha256: postHash,
  ...overrides,
});

describe('private persisted patch-check history', () => {
  let root: string;
  const path = () => join(root, 'state', 'audit.jsonl');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'patch-history-'));
    process.env.DEV_HUB_PATCH_CHECK_STATE_DIR = join(root, 'state');
  });
  afterEach(async () => {
    delete process.env.DEV_HUB_PATCH_CHECK_STATE_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it('returns an empty history for a missing log without creating files', async () => {
    expect(await readPatchCheckAudit()).toEqual([]);
    const report = projectPatchCheckHistory([], SESSION, PLAN, null, new Set());
    expect(report).toMatchObject({
      sessionId: SESSION,
      planId: PLAN,
      total: 0,
      limited: false,
      readOnly: true,
      rawLogsAvailable: false,
      commandsEnabled: false,
      commitEnabled: false,
      pushEnabled: false,
      mergeEnabled: false,
    });
    await expect(lstat(path())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists metadata without secrets, tokens, source code, file paths or logs', async () => {
    const grant = identity();
    const runId = randomUUID();
    await appendPatchCheckAudit('issued', grant);
    await appendPatchCheckAudit('attempted', grant, runId);
    await appendPatchCheckAudit('passed', grant, runId, {
      durationMs: 3200,
      stdoutBytes: 48,
      stderrBytes: 6,
      containerRemoved: true,
    });
    const raw = await readFile(path(), 'utf8');
    const stat = await lstat(path());
    expect(stat.mode & 0o077).toBe(0);
    expect(raw).not.toContain(grant.filePath);
    expect(raw).not.toContain('grantToken');
    expect(raw).not.toContain('operatorSecret');
    expect(raw).not.toContain('stdout:');
    expect(raw).not.toContain('docker.sock');
    expect(raw).toContain(grant.proposedSha256);
    const report = projectPatchCheckHistory(
      await readPatchCheckAudit(),
      SESSION,
      PLAN,
      null,
      new Set(),
    );
    expect(report).toMatchObject({
      total: 1,
      limited: false,
      items: [
        {
          grantId: grant.id,
          runId,
          recipeId: 'API_TEST',
          status: 'passed',
          durationMs: 3200,
          stdoutBytes: 48,
          stderrBytes: 6,
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(grant.filePath);
  });

  it('distinguishes an active process from an interrupted one after restart', async () => {
    const grant = identity();
    const runId = randomUUID();
    await appendPatchCheckAudit('issued', grant);
    await appendPatchCheckAudit('attempted', grant, runId);
    const audit = await readPatchCheckAudit();
    expect(projectPatchCheckHistory(audit, SESSION, PLAN, runId, new Set()).items[0]?.status).toBe(
      'running',
    );
    expect(projectPatchCheckHistory(audit, SESSION, PLAN, null, new Set()).items[0]?.status).toBe(
      'interrupted',
    );
  });

  it('shows authorized only for a live in-memory grant, otherwise expired', async () => {
    const grant = identity();
    await appendPatchCheckAudit('issued', grant);
    const audit = await readPatchCheckAudit();
    expect(
      projectPatchCheckHistory(audit, SESSION, PLAN, null, new Set([grant.id])).items[0]?.status,
    ).toBe('authorized');
    expect(projectPatchCheckHistory(audit, SESSION, PLAN, null, new Set()).items[0]?.status).toBe(
      'expired',
    );
    expect(
      projectPatchCheckHistory(audit, SESSION, PLAN, null, new Set([grant.id]), Date.now() + 60_000)
        .items[0]?.status,
    ).toBe('expired');
  });

  it('preserves cancel-requested and a confirmed canceled terminal outcome', async () => {
    const grant = identity();
    const runId = randomUUID();
    await appendPatchCheckAudit('issued', grant);
    await appendPatchCheckAudit('attempted', grant, runId);
    await appendPatchCheckAudit('cancel-requested', grant, runId);
    const partial = await readPatchCheckAudit();
    expect(
      projectPatchCheckHistory(partial, SESSION, PLAN, runId, new Set()).items[0]?.status,
    ).toBe('cancel-requested');
    expect(projectPatchCheckHistory(partial, SESSION, PLAN, null, new Set()).items[0]?.status).toBe(
      'interrupted',
    );
    await appendPatchCheckAudit('rejected', grant, runId, {
      durationMs: 1200,
      failureKind: 'canceled',
    });
    const report = projectPatchCheckHistory(
      await readPatchCheckAudit(),
      SESSION,
      PLAN,
      null,
      new Set(),
    );
    expect(report.items[0]).toMatchObject({
      status: 'canceled',
      durationMs: 1200,
      stdoutBytes: null,
    });
  });

  it('marks rejected legacy audit records failed rather than guessing a reason', async () => {
    const grant = identity();
    const runId = randomUUID();
    await appendPatchCheckAudit('issued', grant);
    await appendPatchCheckAudit('attempted', grant, runId);
    await appendPatchCheckAudit('rejected', grant, runId);
    const report = projectPatchCheckHistory(
      await readPatchCheckAudit(),
      SESSION,
      PLAN,
      null,
      new Set(),
    );
    expect(report.items[0]?.status).toBe('failed');
  });

  it('scopes by both session and plan; newest first and at most 30 results', async () => {
    const other = identity({ sessionId: OTHER_SESSION, planId: OTHER_PLAN });
    await appendPatchCheckAudit('issued', other);
    for (let i = 0; i < 35; i++) {
      const grant = identity();
      await appendPatchCheckAudit('issued', grant);
    }
    const report = projectPatchCheckHistory(
      await readPatchCheckAudit(),
      SESSION,
      PLAN,
      null,
      new Set(),
    );
    expect(report).toMatchObject({ total: 35, limited: true });
    expect(report.items).toHaveLength(30);
    expect(report.items.some((entry) => entry.grantId === other.id)).toBe(false);
    const otherHistory = projectPatchCheckHistory(
      await readPatchCheckAudit(),
      OTHER_SESSION,
      OTHER_PLAN,
      null,
      new Set(),
    );
    expect(otherHistory.total).toBe(1);
    expect(otherHistory.items[0]?.grantId).toBe(other.id);
  });

  it('rejects tampered, truncated, malformed or unexpected audit fields', async () => {
    const grant = identity();
    await appendPatchCheckAudit('issued', grant);
    const valid = await readFile(path(), 'utf8');
    for (const content of [
      valid.slice(0, -1),
      '{not-json}\n',
      valid.replace('"issued"', '"evil"'),
      valid.replace('"issued"', '"issued","operatorSecret":"abc"'),
    ]) {
      await writeFile(path(), content);
      await expect(readPatchCheckAudit()).rejects.toThrow();
    }
  });

  it('refuses symlinks, group-readable logs and oversized audit files', async () => {
    const grant = identity();
    await appendPatchCheckAudit('issued', grant);
    await chmod(path(), 0o644);
    await expect(readPatchCheckAudit()).rejects.toThrow('Unsafe');
    await chmod(path(), 0o600);
    await writeFile(path(), 'a'.repeat(1024 * 1024 + 2), { mode: 0o600 });
    await expect(readPatchCheckAudit()).rejects.toThrow('Unsafe');
    await rm(path());
    await writeFile(join(root, 'target'), 'outside');
    await symlink(join(root, 'target'), path());
    await expect(readPatchCheckAudit()).rejects.toThrow('Unsafe');
    await expect(appendPatchCheckAudit('issued', grant)).rejects.toThrow('Unsafe');
  });

  it('refuses invalid event ordering, duplicate grants and cross-bound run IDs', async () => {
    const grant = identity();
    const runId = randomUUID();
    await appendPatchCheckAudit('issued', grant);
    await appendPatchCheckAudit('attempted', grant, runId);
    const audit = await readPatchCheckAudit();
    expect(() =>
      projectPatchCheckHistory([...audit, audit[0]!], SESSION, PLAN, null, new Set()),
    ).toThrow('Duplicate');
    const replacement = { ...audit[1]!, runId: randomUUID() };
    expect(() =>
      projectPatchCheckHistory([...audit, replacement], SESSION, PLAN, null, new Set()),
    ).toThrow('Multiple');
    expect(() =>
      projectPatchCheckHistory([audit[1]!, audit[0]!], SESSION, PLAN, null, new Set()),
    ).toThrow('Invalid');
  });
});
