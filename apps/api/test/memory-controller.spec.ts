import { describe, expect, it, vi } from 'vitest';
import { MemoryController } from '../src/memory/memory.controller.js';
import type { MemoryAuthenticatedReadService } from '../src/memory/memory-authenticated-read.service.js';

describe('memory HTTP controller delegates only to authenticated read gateway', () => {
  it('passes the incoming socket, Bearer and untrusted query to the shared gateway', async () => {
    const list = vi.fn().mockResolvedValue({ items: [] });
    const get = vi.fn().mockResolvedValue({ record: { id: 'record' } });
    const revisions = vi.fn().mockResolvedValue({ revisions: [] });
    const c = new MemoryController({
      list,
      get,
      revisions,
    } as unknown as MemoryAuthenticatedReadService);
    const req = {
      method: 'GET',
      originalUrl: '/v1/memory/id?repository=owner/repo',
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        host: '127.0.0.1:3101',
        authorization: 'Bearer sample',
        origin: 'http://127.0.0.1:3100',
        'sec-fetch-site': 'same-origin',
      },
    } as never;
    const query = { repository: 'owner/repo' };
    expect(await c.list(req, query)).toEqual({ items: [] });
    expect(await c.get(req, query, 'id')).toEqual({ record: { id: 'record' } });
    expect(await c.revisions(req, query, 'id')).toEqual({ revisions: [] });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: 'Bearer sample',
        host: '127.0.0.1:3101',
        remoteAddress: '127.0.0.1',
      }),
      query,
    );
    expect(get).toHaveBeenCalledWith(expect.any(Object), query, 'id');
    expect(revisions).toHaveBeenCalledWith(expect.any(Object), query, 'id');
  });
});
