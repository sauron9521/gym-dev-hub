import { defineConfig } from 'prisma/config';
import { validateMemoryDatabaseUrl } from './src/database/memory-database-policy.js';

// Prisma 7 does NOT autoload .env. CLI is launched through the explicit
// guarded scripts; generation works with memory disabled and no URL set.
const url = process.env.DEV_HUB_MEMORY_DATABASE_URL;
// Even a direct Prisma CLI invocation must not access the database while
// Hub memory is disabled. Generate/validate can run without a database.
if (
  process.argv.some((arg) => ['migrate', 'db', 'studio'].includes(arg)) &&
  (process.env.DEV_HUB_MEMORY_ENABLE !== 'true' || !url)
) {
  throw new Error('Hub memory database migration disabled: explicit opt-in and local URL required');
}
if (url) {
  const purpose = process.env.DEV_HUB_MEMORY_DB_PURPOSE === 'test' ? 'test' : 'development';
  validateMemoryDatabaseUrl(url, purpose);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url },
});
