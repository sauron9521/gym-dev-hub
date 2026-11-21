import { z } from 'zod';

/** Data contracts only. This package does not register memory APIs or grants. */
export const MEMORY_SCHEMA_VERSION = 1 as const;
export const MemoryRepositorySchema = z
  .string()
  .min(3)
  .max(200)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    'expected explicit owner/repository',
  );
export const MemoryKindSchema = z.enum(['fact', 'decision', 'constraint', 'proposal']);
export const MemoryStatusSchema = z.enum(['proposed', 'verified', 'superseded', 'revoked']);
export const MemoryScopeSchema = z.enum(['project', 'task', 'session']);
export const MemorySourceTypeSchema = z.enum(['github', 'workspace', 'human', 'agent']);

const uuid = z.uuid();
const date = z.iso.datetime({ offset: true });
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const requiredIdentity = z.string().trim().min(1).max(200);
const content = z.string().trim().min(1).max(4096);

const version = z.object({ schemaVersion: z.literal(1) });
export const MemoryRecordSchema = version
  .extend({
    id: uuid,
    repository: MemoryRepositorySchema,
    scope: MemoryScopeSchema,
    kind: MemoryKindSchema,
    status: MemoryStatusSchema,
    text: content,
    revision: z.int().positive(),
    taskId: uuid.nullable(),
    sessionId: uuid.nullable(),
    agentId: uuid.nullable(),
    sourceSha: sha.nullable(),
    supersededById: uuid.nullable(),
    expiresAt: date.nullable(),
    verifiedBy: requiredIdentity.nullable(),
    verifiedAt: date.nullable(),
    createdAt: date,
    updatedAt: date,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope === 'project' && (value.taskId !== null || value.sessionId !== null)) {
      context.addIssue({ code: 'custom', message: 'project scope cannot name a task or session' });
    }
    if (value.scope === 'task' && (value.taskId === null || value.sessionId !== null)) {
      context.addIssue({ code: 'custom', message: 'task scope requires only taskId' });
    }
    if (value.scope === 'session' && (value.sessionId === null || value.taskId !== null)) {
      context.addIssue({ code: 'custom', message: 'session scope requires only sessionId' });
    }
    if (value.status === 'verified' && (value.verifiedBy === null || value.verifiedAt === null)) {
      context.addIssue({ code: 'custom', message: 'verified status requires attribution' });
    }
  });

export const MemoryProvenanceSchema = version
  .extend({
    id: uuid,
    memoryId: uuid,
    repository: MemoryRepositorySchema,
    sourceType: MemorySourceTypeSchema,
    actorId: requiredIdentity,
    sourceRef: z.string().trim().min(1).max(512),
    sourceSha: sha.nullable(),
    observedAt: date,
    createdAt: date,
  })
  .strict();

export const MemoryRevisionSchema = version
  .extend({
    id: uuid,
    memoryId: uuid,
    repository: MemoryRepositorySchema,
    revision: z.int().positive(),
    scope: MemoryScopeSchema,
    kind: MemoryKindSchema,
    status: MemoryStatusSchema,
    text: content,
    sourceSha: sha.nullable(),
    sourceId: uuid.nullable(),
    changedBy: requiredIdentity,
    createdAt: date,
  })
  .strict();

export type MemoryRecordDto = z.infer<typeof MemoryRecordSchema>;
export type MemoryProvenanceDto = z.infer<typeof MemoryProvenanceSchema>;
export type MemoryRevisionDto = z.infer<typeof MemoryRevisionSchema>;
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export type MemoryKind = z.infer<typeof MemoryKindSchema>;
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;
