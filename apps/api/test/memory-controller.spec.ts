import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { MemoryController } from '../src/memory/memory.controller.js';

describe('memory read routes remain disabled until authentication #39', () => {
  it('all three routes return 503, without a database, on any configuration', () => {
    const c = new MemoryController();
    for (const action of [() => c.list(), () => c.get(), () => c.revisions()]) {
      try {
        action();
        throw new Error('Expected 503');
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect((error as ServiceUnavailableException).getStatus()).toBe(503);
      }
    }
  });
});
