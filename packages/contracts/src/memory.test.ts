import { describe, expect, it } from 'vitest';
import {
  MemoryRecordSchema,
  MemoryProvenanceSchema,
  MemoryRevisionSchema,
  MemoryRepositorySchema,
} from './memory.js';

const id = '25185b6b-36f2-4ad9-aef1-030f14725e0b';
const id2 = '35185b6b-36f2-4ad9-aef1-030f14725e0b';
const now = '2026-11-21T12:00:00.000Z';
const record = {
  schemaVersion: 1,
  id,
  repository: 'sauron9521/gym-dev-hub',
  scope: 'project',
  kind: 'decision',
  status: 'proposed',
  text: 'Keep all Git commits reviewed.',
  revision: 1,
  taskId: null,
  sessionId: null,
  agentId: null,
  sourceSha: null,
  supersededById: null,
  expiresAt: null,
  verifiedBy: null,
  verifiedAt: null,
  createdAt: now,
  updatedAt: now,
};

describe('Shared Agent Memory v1 Zod contracts', () => {
  it('accepts explicit nullable project record, not an implicit global scope', () => {
    expect(MemoryRecordSchema.parse(record).scope).toBe('project');
  });
  it.each(['../repo', 'repo', 'a/*', 'a/b/c', '', 'http://github.com/owner/repo'])(
    'rejects invalid repo scope %s',
    (repo) => {
      expect(MemoryRepositorySchema.safeParse(repo).success).toBe(false);
    },
  );
  it('rejects unknown props, unsupported schema versions and unbounded content', () => {
    expect(MemoryRecordSchema.safeParse({ ...record, credential: 'private' }).success).toBe(false);
    expect(MemoryRecordSchema.safeParse({ ...record, schemaVersion: 2 }).success).toBe(false);
    expect(MemoryRecordSchema.safeParse({ ...record, text: 'x'.repeat(4097) }).success).toBe(false);
    expect(MemoryRecordSchema.safeParse({ ...record, revision: 0 }).success).toBe(false);
  });
  it('requires explicit task or session ID matching selected scope', () => {
    expect(MemoryRecordSchema.safeParse({ ...record, scope: 'task', taskId: null }).success).toBe(
      false,
    );
    expect(MemoryRecordSchema.safeParse({ ...record, scope: 'task', taskId: id2 }).success).toBe(
      true,
    );
    expect(
      MemoryRecordSchema.safeParse({ ...record, scope: 'session', sessionId: id2, taskId: id })
        .success,
    ).toBe(false);
    expect(
      MemoryRecordSchema.safeParse({ ...record, scope: 'session', sessionId: id2 }).success,
    ).toBe(true);
  });
  it('rejects unapproved verified records without verifier and timestamp', () => {
    expect(MemoryRecordSchema.safeParse({ ...record, status: 'verified' }).success).toBe(false);
    expect(
      MemoryRecordSchema.safeParse({
        ...record,
        status: 'verified',
        verifiedBy: 'operator',
        verifiedAt: now,
      }).success,
    ).toBe(true);
  });
  it('requires attributed, bounded provenance and commit SHA', () => {
    const source = {
      schemaVersion: 1,
      id: id2,
      repository: record.repository,
      memoryId: id,
      sourceType: 'github',
      actorId: 'operator',
      sourceRef: 'PR #88',
      sourceSha: 'a'.repeat(40),
      observedAt: now,
      createdAt: now,
    };
    expect(MemoryProvenanceSchema.safeParse(source).success).toBe(true);
    expect(MemoryProvenanceSchema.safeParse({ ...source, sourceSha: 'latest' }).success).toBe(
      false,
    );
    expect(MemoryProvenanceSchema.safeParse({ ...source, actorId: '' }).success).toBe(false);
  });
  it('validates an immutable revision DTO as a strict shape', () => {
    const revision = {
      schemaVersion: 1,
      id: id2,
      repository: record.repository,
      memoryId: id,
      revision: 1,
      scope: record.scope,
      kind: record.kind,
      status: record.status,
      text: record.text,
      sourceSha: null,
      sourceId: null,
      changedBy: 'system',
      createdAt: now,
    };
    expect(MemoryRevisionSchema.safeParse(revision).success).toBe(true);
    expect(MemoryRevisionSchema.safeParse({ ...revision, changedBy: null }).success).toBe(false);
    expect(MemoryRevisionSchema.safeParse({ ...revision, extra: 1 }).success).toBe(false);
  });
});
