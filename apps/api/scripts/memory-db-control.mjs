/** Explicit, local-only Hub memory DB actions. No automatic startup or JSON fallback. */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveMemoryDatabaseConfiguration } from '../src/database/memory-database-policy.ts';

const API = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(API, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const action = process.argv[2];
const VALID_ACTIONS = new Set(['status', 'health', 'health:test', 'migrate', 'migrate:test']);
if (!VALID_ACTIONS.has(action) || process.argv.length !== 3) {
  console.error('Usage: memory-db-control <status|health|health:test|migrate|migrate:test>');
  process.exitCode = 1;
} else {
  const purpose = action.endsWith(':test') ? 'test' : 'development';
  try {
    const config = resolveMemoryDatabaseConfiguration(process.env, purpose);
    if (!config.enabled) {
      console.log('HUB_MEMORY_DISABLED: no database connection attempted');
      if (action !== 'status') process.exitCode = 1;
    } else if (action === 'status') {
      console.log(
        'HUB_MEMORY_CONFIGURED',
        JSON.stringify({
          database: config.database,
          host: config.host,
          port: config.port,
          memoryRoutesEnabled: false,
        }),
      );
    } else if (action.startsWith('health')) {
      const client = new pg.Client({
        connectionString: config.url,
        ssl: false,
        connectionTimeoutMillis: 4000,
        query_timeout: 5000,
      });
      try {
        await client.connect();
        const res = await client.query(
          "SELECT current_database() AS name, to_regclass('public._prisma_migrations')::text AS migration_table",
        );
        if (
          res.rows[0]?.name !== config.database ||
          res.rows[0]?.migration_table !== '_prisma_migrations'
        ) {
          throw new Error('expected target database or migration ledger unavailable');
        }
        console.log(
          'HUB_MEMORY_DB_HEALTHY',
          JSON.stringify({
            database: config.database,
            migrations: true,
            memoryRoutesEnabled: false,
          }),
        );
      } finally {
        await client.end().catch(() => {});
      }
    } else {
      const env = {
        ...process.env,
        DEV_HUB_MEMORY_DATABASE_URL: config.url,
        DEV_HUB_MEMORY_DB_PURPOSE: purpose,
      };
      const result = spawnSync(
        'pnpm',
        ['exec', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
        {
          cwd: API,
          env,
          timeout: 60_000,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        },
      );
      if (result.error || result.status !== 0) {
        // Avoid leaking raw driver/CLI errors containing connection-string secrets.
        throw new Error(`guarded Prisma migration failed (${result.error?.code ?? result.status})`);
      }
      console.log(
        'HUB_MEMORY_MIGRATION_APPLIED',
        JSON.stringify({ database: config.database, purpose, memoryRoutesEnabled: false }),
      );
    }
  } catch (error) {
    const policy = error?.name === 'MemoryDatabasePolicyError';
    console.error(
      'HUB_MEMORY_DB_REJECTED',
      policy ? error.message : 'database unavailable or operation failed (details withheld)',
    );
    process.exitCode = 1;
  }
}
