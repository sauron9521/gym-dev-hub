import { z } from 'zod';

export const createSessionSchema = z.strictObject({
  title: z.string().trim().min(2).max(120),
  repository: z.string().trim().min(3).max(200),
  task: z.string().trim().min(3).max(1500),
});

export const updateSessionSchema = z
  .strictObject({
    title: z.string().trim().min(2).max(120).optional(),
    task: z.string().trim().min(3).max(1500).optional(),
    status: z.enum(['planned', 'in-progress', 'review', 'completed']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Порожнє оновлення' });

export const createMessageSchema = z.strictObject({
  content: z.string().trim().min(1).max(4000),
});

export const persistedWorkspaceSchema = z.strictObject({
  version: z.literal(1),
  sessions: z.array(
    createSessionSchema.omit({ repository: true }).extend({
      id: z.uuid(),
      repository: z.string(),
      status: z.enum(['planned', 'in-progress', 'review', 'completed']),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      codexThreadId: z.string().min(4).max(128).nullable().optional(),
      chatMessages: z
        .array(
          z.strictObject({
            id: z.uuid(),
            role: z.enum(['user', 'assistant']),
            content: z.string().max(20000),
            createdAt: z.iso.datetime(),
            state: z.enum(['completed', 'failed', 'interrupted']),
          }),
        )
        .max(100)
        .optional(),
      messages: z.array(
        z.strictObject({
          id: z.uuid(),
          role: z.literal('user'),
          content: z.string().max(4000),
          createdAt: z.iso.datetime(),
        }),
      ),
    }),
  ),
});

export type PersistedWorkspace = z.infer<typeof persistedWorkspaceSchema>;
