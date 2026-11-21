import { describe, expect, it } from 'vitest';
import {
  resolveMemoryDatabaseConfiguration,
  validateMemoryDatabaseUrl,
} from '../src/database/memory-database-policy.js';

const dev = 'postgresql://gym_dev_hub:test-only-password@127.0.0.1:55441/gym_dev_hub_memory';
const test = 'postgresql://gym_dev_hub:test-only-password@localhost:55441/gym_dev_hub_memory_test';

describe('Hub memory database strict opt-in', () => {
  it('keeps existing API independent of absent DB configuration', () => {
    expect(resolveMemoryDatabaseConfiguration({})).toEqual({ enabled: false, status: 'disabled' });
    expect(
      resolveMemoryDatabaseConfiguration({
        DEV_HUB_MEMORY_ENABLE: 'false',
        DEV_HUB_MEMORY_DATABASE_URL: dev,
      }),
    ).toEqual({ enabled: false, status: 'disabled' });
  });
  it('accepts only dedicated loopback Hub DB for explicit enable', () => {
    expect(
      resolveMemoryDatabaseConfiguration({
        DEV_HUB_MEMORY_ENABLE: 'true',
        DEV_HUB_MEMORY_DATABASE_URL: dev,
      }),
    ).toMatchObject({
      enabled: true,
      database: 'gym_dev_hub_memory',
      host: '127.0.0.1',
      port: 55441,
    });
    expect(
      resolveMemoryDatabaseConfiguration(
        { DEV_HUB_MEMORY_ENABLE: 'true', DEV_HUB_MEMORY_TEST_DATABASE_URL: test },
        'test',
      ),
    ).toMatchObject({ enabled: true, database: 'gym_dev_hub_memory_test' });
  });
  it.each(['TRUE', 'yes', '1', 'invalid'])('rejects ambiguous enable flag %s', (flag) => {
    expect(() => resolveMemoryDatabaseConfiguration({ DEV_HUB_MEMORY_ENABLE: flag })).toThrow(
      'exactly true or false',
    );
  });
  it('fails closed when enabled but target is missing', () => {
    expect(() => resolveMemoryDatabaseConfiguration({ DEV_HUB_MEMORY_ENABLE: 'true' })).toThrow(
      'required DEV_HUB_MEMORY_DATABASE_URL',
    );
  });
  it.each([
    'postgresql://gym_dev_hub:secret@remote.example:5432/gym_dev_hub_memory',
    'postgresql://gym_dev_hub:secret@127.0.0.1:55441/gym_platform',
    'postgresql://gym_dev_hub:secret@127.0.0.1:55441/postgres',
    'postgresql://gym_dev_hub:secret@127.0.0.1:55441/gym_dev_hub_memory_test',
    'postgresql://postgres:secret@127.0.0.1:55441/gym_dev_hub_memory',
    'postgresql://gym_dev_hub@127.0.0.1:55441/gym_dev_hub_memory',
    'http://gym_dev_hub:secret@127.0.0.1/gym_dev_hub_memory',
    'postgresql://gym_dev_hub:secret@127.0.0.1/gym_dev_hub_memory?schema=public',
    'not-a-url',
  ])('rejects non-Hub or unsafe dev URL', (value) => {
    expect(() => validateMemoryDatabaseUrl(value, 'development')).toThrow();
  });
  it('never echoes passwords in policy errors', () => {
    expect(() =>
      validateMemoryDatabaseUrl(
        'postgresql://gym_dev_hub:do-not-echo-this@remote.example/gym_dev_hub_memory',
        'development',
      ),
    ).toThrowError(/loopback/);
    try {
      validateMemoryDatabaseUrl(
        'postgresql://gym_dev_hub:do-not-echo-this@remote.example/gym_dev_hub_memory',
        'development',
      );
    } catch (e) {
      expect(String(e)).not.toContain('do-not-echo-this');
    }
  });
  it('disallows normal DB in test mode and test DB in normal mode', () => {
    expect(() => validateMemoryDatabaseUrl(dev, 'test')).toThrow();
    expect(() => validateMemoryDatabaseUrl(test, 'development')).toThrow();
  });
});
