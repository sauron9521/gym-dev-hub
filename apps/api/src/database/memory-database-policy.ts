/** Strict, opt-in, local-only database scope for future Hub memory modules. */
export type MemoryDatabasePurpose = 'development' | 'test';
export type MemoryDatabaseConfiguration =
  | { enabled: false; status: 'disabled' }
  | {
      enabled: true;
      status: 'configured';
      database: string;
      host: string;
      port: number;
      url: string;
    };

const SAFE_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DATABASES: Record<MemoryDatabasePurpose, string> = {
  development: 'gym_dev_hub_memory',
  test: 'gym_dev_hub_memory_test',
};

export class MemoryDatabasePolicyError extends Error {
  constructor(reason: string) {
    super(`Hub memory database rejected: ${reason}`);
    this.name = 'MemoryDatabasePolicyError';
  }
}

export function validateMemoryDatabaseUrl(
  value: string,
  purpose: MemoryDatabasePurpose,
): { host: string; port: number; database: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MemoryDatabasePolicyError('invalid PostgreSQL connection URL');
  }
  // This foundation intentionally supports ONLY this independent local Hub DB.
  // No arbitrary production endpoints, alternate schemas, sockets or user names.
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new MemoryDatabasePolicyError('expected PostgreSQL URL scheme');
  }
  if (!SAFE_HOSTS.has(parsed.hostname)) {
    throw new MemoryDatabasePolicyError('only loopback PostgreSQL connections are permitted');
  }
  if (decodeURIComponent(parsed.username) !== 'gym_dev_hub' || !parsed.password) {
    throw new MemoryDatabasePolicyError(
      'a dedicated Hub database user and nonempty password are required',
    );
  }
  if (parsed.search || parsed.hash || parsed.pathname !== `/${DATABASES[purpose]}`) {
    throw new MemoryDatabasePolicyError(
      `only dedicated ${purpose} database ${DATABASES[purpose]} is permitted`,
    );
  }
  const port = Number(parsed.port || '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MemoryDatabasePolicyError('invalid database port');
  }
  return { host: parsed.hostname, port, database: DATABASES[purpose] };
}

export function resolveMemoryDatabaseConfiguration(
  env: Record<string, string | undefined>,
  purpose: MemoryDatabasePurpose = 'development',
): MemoryDatabaseConfiguration {
  if (!env.DEV_HUB_MEMORY_ENABLE || env.DEV_HUB_MEMORY_ENABLE === 'false') {
    return { enabled: false, status: 'disabled' };
  }
  if (env.DEV_HUB_MEMORY_ENABLE !== 'true') {
    throw new MemoryDatabasePolicyError('DEV_HUB_MEMORY_ENABLE must be exactly true or false');
  }
  const key =
    purpose === 'test' ? 'DEV_HUB_MEMORY_TEST_DATABASE_URL' : 'DEV_HUB_MEMORY_DATABASE_URL';
  const url = env[key];
  if (!url) throw new MemoryDatabasePolicyError(`required ${key} is not configured`);
  const target = validateMemoryDatabaseUrl(url, purpose);
  return { enabled: true, status: 'configured', ...target, url };
}
