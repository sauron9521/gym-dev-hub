import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { MemoryController } from '../src/memory/memory.controller.js';
import type { MemoryAuthenticatedReadService } from '../src/memory/memory-authenticated-read.service.js';

describe('memory HTTP route boundaries', () => {
  it('detail and revisions remain 503 even when list is opted in', () => {
    const c = new MemoryController({ list: vi.fn() } as unknown as MemoryAuthenticatedReadService);
    for (const action of [() => c.get(), () => c.revisions()]) {
      expect(action).toThrowError(ServiceUnavailableException);
    }
  });
});
