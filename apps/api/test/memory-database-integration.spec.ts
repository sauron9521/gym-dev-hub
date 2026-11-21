import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { resolveMemoryDatabaseConfiguration } from '../src/database/memory-database-policy.js';

const eligible =
  process.env.DEV_HUB_MEMORY_ENABLE === 'true' &&
  Boolean(process.env.DEV_HUB_MEMORY_TEST_DATABASE_URL);

describe.skipIf(!eligible)('opt-in Hub memory PostgreSQL integration (test DB only)', () => {
  it('reaches ONLY the dedicated isolated test DB after a checked migration', async () => {
    const config = resolveMemoryDatabaseConfiguration(process.env, 'test');
    if (!config.enabled) throw new Error('Expected explicitly enabled test database');
    const client = new pg.Client({
      connectionString: config.url,
      ssl: false,
      connectionTimeoutMillis: 4_000,
    });
    try {
      await client.connect();
      const result = await client.query(
        "SELECT current_database() AS name, to_regclass('public._prisma_migrations')::text AS migration_table",
      );
      expect(result.rows).toEqual([
        { name: 'gym_dev_hub_memory_test', migration_table: '_prisma_migrations' },
      ]);
      const migrations = await client.query(
        'SELECT migration_name, finished_at FROM public._prisma_migrations',
      );
      expect(migrations.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            migration_name: '20261121120000_memory_storage_baseline',
            finished_at: expect.any(Date),
          }),
          expect.objectContaining({
            migration_name: '20261121124913_memory_typed_records',
            finished_at: expect.any(Date),
          }),
          expect.objectContaining({
            migration_name: '20261121172000_memory_proposal_intake',
            finished_at: expect.any(Date),
          }),
          expect.objectContaining({
            migration_name: '20261121183000_memory_operator_approval',
            finished_at: expect.any(Date),
          }),
        ]),
      );
      expect(migrations.rowCount).toBe(4);
    } finally {
      await client.end();
    }
  });
});
