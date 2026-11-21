import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { MemoryStatusController } from '../src/database/memory-status.controller.js';

describe('Shared memory API disabled by default', () => {
  it('always fails closed with HTTP 503 without opening any memory route', () => {
    const controller = new MemoryStatusController();
    expect(() => controller.status()).toThrow(ServiceUnavailableException);
    try {
      controller.status();
    } catch (error) {
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
      expect((error as Error).message).toMatch(/disabled/);
    }
  });
});
