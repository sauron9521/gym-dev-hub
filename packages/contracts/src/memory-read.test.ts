import { describe, expect, it } from 'vitest';
import { MemoryReadQuerySchema, MemoryReadContextSchema } from './memory-read.js';

const repository = 'sauron9521/gym-dev-hub';
describe('memory read-only contract constraints', () => {
  it('defaults to bounded paging and rejects unbounded or malformed limits', () => {
    expect(MemoryReadQuerySchema.parse({ repository }).limit).toBe(20);
    expect(MemoryReadQuerySchema.parse({ repository, limit: '50' }).limit).toBe(50);
    for (const limit of ['0', '51', '1.5', 'NaN', '100000'])
      expect(MemoryReadQuerySchema.safeParse({ repository, limit }).success).toBe(false);
  });
  it('requires valid repo and known filter keys', () => {
    expect(MemoryReadQuerySchema.safeParse({ repository: 'foo', limit: 5 }).success).toBe(false);
    expect(MemoryReadQuerySchema.safeParse({ repository, secret: 'x' }).success).toBe(false);
    expect(MemoryReadQuerySchema.safeParse({ repository, scope: 'PRIVATE' }).success).toBe(false);
  });
  it('rejects unknown principal keys and malformed agent ID', () => {
    expect(MemoryReadContextSchema.safeParse({ repository, agentId: 'all' }).success).toBe(false);
    expect(MemoryReadContextSchema.safeParse({ repository, admin: true }).success).toBe(false);
  });
});
