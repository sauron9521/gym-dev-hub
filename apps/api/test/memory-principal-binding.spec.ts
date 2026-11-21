import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryPrincipal } from '../src/security/memory-authorization.service.js';
import { verifyMemoryPrincipalBinding } from '../src/security/memory-principal-binding.js';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';
import { authenticateMemoryHttpReadWithDatabase } from '../src/security/memory-http-identity.js';

const repository = 'sauron9521/gym-dev-hub';
const secret = 'memory-test-operator-secret-that-is-long';
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repository,
  DEV_HUB_MEMORY_OPERATOR_SECRET: secret,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
};
const allPresent = () => ({
  repository_exists: true,
  task_exists: true,
  agent_exists: true,
  session_exists: true,
  membership_exists: true,
});
const dbStub = (row = allPresent()) => {
  const query = vi.fn().mockResolvedValue({ rows: [row] });
  return { query, db: { query } as unknown as Pick<pg.Pool, 'query'> };
};
const agent = (context: Partial<MemoryPrincipal['readContext']> = {}): MemoryPrincipal => ({
  type: 'agent',
  actorId: randomUUID(),
  repository,
  permission: 'READ_VERIFIED',
  readContext: { repository, agentId: randomUUID(), ...context },
});
const httpRequest = (authorization?: string) => ({
  method: 'GET',
  host: '127.0.0.1:3101',
  remoteAddress: '127.0.0.1',
  origin: 'http://127.0.0.1:3100',
  fetchSite: 'same-origin',
  path: '/v1/memory',
  authorization,
});

describe('database-bound memory principal (unmounted)', () => {
  it('uses only bearer-derived repository/task/agent/session in a parameterized same-repository lookup', async () => {
    const { db, query } = dbStub();
    const principal = agent({ taskId: randomUUID(), sessionId: randomUUID() });
    expect(await verifyMemoryPrincipalBinding(principal, db)).toEqual(principal);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('s.repository=$1');
    expect(sql).toContain('s.task_id IS NOT DISTINCT FROM $2::uuid');
    expect(sql).toContain('s.agent_id IS NOT DISTINCT FROM $3::uuid');
    expect(sql).toContain('s.task_id=$2::uuid AND s.agent_id=$3::uuid');
    expect(params).toEqual([
      repository,
      principal.readContext.taskId,
      principal.readContext.agentId,
      principal.readContext.sessionId,
    ]);
  });

  it.each([
    ['repository_exists'],
    ['task_exists'],
    ['agent_exists'],
    ['session_exists'],
    ['membership_exists'],
  ] as const)('fails closed when %s is false', async (field) => {
    const { db } = dbStub({ ...allPresent(), [field]: false });
    await expect(
      verifyMemoryPrincipalBinding(agent({ taskId: randomUUID(), sessionId: randomUUID() }), db),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects missing result, database outage and malformed principal without leaking errors', async () => {
    const { db } = dbStub();
    await expect(
      verifyMemoryPrincipalBinding(
        {
          ...agent(),
          repository: 'sauron9521/other',
        },
        db,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const missing = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pick<
      pg.Pool,
      'query'
    >;
    await expect(verifyMemoryPrincipalBinding(agent(), missing)).rejects.toMatchObject({
      code: 'forbidden',
    });
    const failed = {
      query: vi.fn().mockRejectedValue(new Error('private DB connection details')),
    } as unknown as Pick<pg.Pool, 'query'>;
    await expect(verifyMemoryPrincipalBinding(agent(), failed)).rejects.toMatchObject({
      code: 'disabled',
      message: 'Memory security disabled',
    });
    const malformed = agent({ sessionId: randomUUID() });
    await expect(verifyMemoryPrincipalBinding(malformed, db)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('rejects external agents and agent credentials without agent identity', async () => {
    const { db } = dbStub();
    const principal = agent();
    await expect(
      verifyMemoryPrincipalBinding(
        {
          ...principal,
          type: 'external',
        },
        db,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      verifyMemoryPrincipalBinding(
        {
          ...principal,
          readContext: { repository },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      verifyMemoryPrincipalBinding(
        {
          ...principal,
          type: 'external',
          readContext: { repository },
        },
        db,
      ),
    ).resolves.toMatchObject({ type: 'external' });
  });

  it('checks HTTP bearer before touching database, maps unknown membership to 403 and outage to 503', async () => {
    const authorization = new MemoryAuthorizationService(env);
    const bearer = authorization.provisionReadCredential(secret, {
      kind: 'agent',
      repository,
      agentId: randomUUID(),
      ttlSeconds: 60,
    }).bearerToken;
    const { db, query } = dbStub({ ...allPresent(), agent_exists: false });
    await expect(
      authenticateMemoryHttpReadWithDatabase(httpRequest(), authorization, env, db),
    ).rejects.toMatchObject({ status: 401 });
    expect(query).not.toHaveBeenCalled();
    await expect(
      authenticateMemoryHttpReadWithDatabase(
        httpRequest('Bearer ' + bearer),
        authorization,
        env,
        db,
      ),
    ).rejects.toMatchObject({ status: 403 });
    const failed = {
      query: vi.fn().mockRejectedValue(new Error('db password leaked')),
    } as unknown as Pick<pg.Pool, 'query'>;
    await expect(
      authenticateMemoryHttpReadWithDatabase(
        httpRequest('Bearer ' + bearer),
        authorization,
        env,
        failed,
      ),
    ).rejects.toMatchObject({ status: 503, message: 'Memory access disabled' });
  });
});
