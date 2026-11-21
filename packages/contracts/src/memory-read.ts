import { z } from 'zod';
import {
  MemoryKindSchema,
  MemoryProvenanceSchema,
  MemoryRecordSchema,
  MemoryRepositorySchema,
  MemoryRevisionSchema,
  MemoryScopeSchema,
} from './memory.js';

/** Internal read DTOs. Public routes remain disabled until #39 authentication. */
export const MemoryReadQuerySchema = z
  .object({
    repository: MemoryRepositorySchema,
    scope: MemoryScopeSchema.optional(),
    taskId: z.uuid().optional(),
    kind: MemoryKindSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export const MemoryReadContextSchema = z
  .object({
    repository: MemoryRepositorySchema,
    taskId: z.uuid().optional(),
    sessionId: z.uuid().optional(),
    agentId: z.uuid().optional(),
  })
  .strict();
export const MemoryReadItemSchema = z
  .object({
    record: MemoryRecordSchema,
    provenance: MemoryProvenanceSchema,
    freshness: z
      .object({
        sourceObservedAt: z.iso.datetime({ offset: true }),
        sourceStale: z.literal(false),
      })
      .strict(),
  })
  .strict();
export const MemoryReadPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: MemoryRepositorySchema,
    items: z.array(MemoryReadItemSchema).max(50),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const MemoryReadRevisionsSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: MemoryRepositorySchema,
    memoryId: z.uuid(),
    revisions: z.array(MemoryRevisionSchema),
  })
  .strict();
export type MemoryReadQuery = z.infer<typeof MemoryReadQuerySchema>;
export type MemoryReadContext = z.infer<typeof MemoryReadContextSchema>;
export type MemoryReadItem = z.infer<typeof MemoryReadItemSchema>;
export type MemoryReadPage = z.infer<typeof MemoryReadPageSchema>;
export type MemoryReadRevisions = z.infer<typeof MemoryReadRevisionsSchema>;
