import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';
import { MemoryProposalController } from '../src/memory/memory-proposal.controller.js';
import { MemoryProposalService } from '../src/memory/memory-proposal.service.js';

const secret = 'local-proposal-http-operator-secret-long-enough';
const repository = 'sauron9521/gym-dev-hub';
const taskId = randomUUID();
const agentId = randomUUID();
const sessionId = randomUUID();
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_SECRET: secret,
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repository,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
  DEV_HUB_MEMORY_DATABASE_URL:
    'postgresql://gym_dev_hub:fixture@127.0.0.1:55441/gym_dev_hub_memory',
};
const authorization = new MemoryAuthorizationService(env);
const scope = { kind: 'agent' as const, repository, agentId, taskId, sessionId, ttlSeconds: 90 };
const read = authorization.provisionReadCredential(secret, scope);
const proposed = authorization.provisionReadCredential(secret, {
  ...scope,
  permission: 'PROPOSE_MEMORY',
});
const lookup = new Map<string, { payload_digest: string; memory_id: string }>();
const sql = vi.fn(async (statement: string, params: unknown[] = []) => {
  if (statement.includes('memory_repositories'))
    return {
      rows: [
        {
          repository_exists: true,
          task_exists: true,
          agent_exists: true,
          session_exists: true,
          membership_exists: true,
        },
      ],
    };
  if (statement.includes('SELECT payload_digest, memory_id')) {
    const id = String(params[3]);
    const existing = lookup.get(id);
    return { rows: existing ? [existing] : [] };
  }
  if (statement.includes('INSERT INTO memory_proposal_requests')) {
    lookup.set(String(params[3]), {
      payload_digest: String(params[4]),
      memory_id: String(params[5]),
    });
  }
  return { rows: [] };
});
const client = { query: sql, release: vi.fn() };
const pool = {
  connect: async () => client,
  end: vi.fn(async () => undefined),
} as unknown as pg.Pool;
const service = new MemoryProposalService(authorization, env, () => pool);

@Module({
  controllers: [MemoryProposalController],
  providers: [{ provide: MemoryProposalService, useValue: service }],
})
class TestModule {}

describe('Nest POST /v1/memory/proposals (separate write capability)', () => {
  let app: INestApplication;
  let url: string;
  const route = '/v1/memory/proposals';
  const payload = () => ({
    kind: 'fact',
    text: 'An untrusted proposed fact',
    sourceRef: 'session-log:123',
  });
  const headers = {
    origin: 'http://127.0.0.1:3100',
    'content-type': 'application/json',
    authorization: 'Bearer ' + proposed.bearerToken,
    'idempotency-key': randomUUID(),
  };
  const post = (
    body: unknown = payload(),
    extra: Record<string, string> = headers,
    target = route,
  ) =>
    fetch(url + target, {
      method: 'POST',
      headers: extra,
      body: JSON.stringify(body),
      redirect: 'manual',
    });

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it('returns only a receipt with no-store and server-derived identity', async () => {
    sql.mockClear();
    const response = await post();
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.json()).toMatchObject({
      status: 'PROPOSED',
      revision: 1,
      replayed: false,
    });
    const queries = sql.mock.calls.map(([statement]) => statement);
    expect(queries.some((s) => s.includes('INSERT INTO memory_records'))).toBe(true);
    const recordParams = sql.mock.calls.find(([s]) =>
      s.includes('INSERT INTO memory_records'),
    )?.[1];
    expect(recordParams?.[1]).toBe(repository);
    expect(recordParams?.[4]).toBe(sessionId);
    expect(recordParams?.[5]).toBe(agentId);
  });

  it('repeats an identical key without creating a second record and rejects changed payload', async () => {
    const key = randomUUID();
    const reqHeaders = { ...headers, 'idempotency-key': key };
    const first = await post(payload(), reqHeaders);
    const created = (await first.json()) as { recordId: string };
    const next = await post(payload(), reqHeaders);
    expect(next.status).toBe(201);
    expect(await next.json()).toMatchObject({ recordId: created.recordId, replayed: true });
    const changed = await post({ ...payload(), text: 'different text' }, reqHeaders);
    expect(changed.status).toBe(409);
  });

  it('denies missing or read-only bearer before database access', async () => {
    sql.mockClear();
    for (const authorizationValue of ['', 'Bearer bad', 'Bearer ' + read.bearerToken]) {
      const response = await post(payload(), { ...headers, authorization: authorizationValue });
      expect(response.status).toBe(authorizationValue.endsWith(read.bearerToken) ? 403 : 401);
    }
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects untrusted scopes, forged approval state and absent idempotency', async () => {
    sql.mockClear();
    for (const body of [
      { ...payload(), status: 'VERIFIED' },
      { ...payload(), repository: 'sauron9521/gym-platform' },
      { ...payload(), agentId: randomUUID() },
      { ...payload(), verifiedBy: 'operator' },
      { ...payload(), text: 'password = some-really-secret-value' },
      { ...payload(), sourceRef: 'foo\nbar' },
    ])
      expect((await post(body)).status).toBe(400);
    for (const key of ['', 'not-a-uuid']) {
      expect((await post(payload(), { ...headers, 'idempotency-key': key })).status).toBe(400);
    }
    expect(sql).not.toHaveBeenCalled();
  });

  it('denies malicious origin, cross-site, secret URL and invalid JSON content type', async () => {
    sql.mockClear();
    for (const opts of [
      { target: route, headers: { ...headers, origin: 'http://attacker.example' } },
      { target: route, headers: { ...headers, 'sec-fetch-site': 'cross-site' } },
      { target: route + '?token=leaked', headers },
      { target: route, headers: { ...headers, 'content-type': 'text/plain' } },
    ])
      expect((await post(payload(), opts.headers, opts.target)).status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
  });

  it('remains 503 with the independent write switch disabled and cannot use revoked bearer', async () => {
    sql.mockClear();
    env.DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE = 'false';
    try {
      expect((await post()).status).toBe(503);
    } finally {
      env.DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE = 'true';
    }
    const bearer = authorization.provisionReadCredential(secret, {
      ...scope,
      permission: 'PROPOSE_MEMORY',
    });
    authorization.revokeCredential(secret, bearer.credentialId);
    expect(
      (
        await post(payload(), {
          ...headers,
          authorization: 'Bearer ' + bearer.bearerToken,
        })
      ).status,
    ).toBe(401);
    expect(sql).not.toHaveBeenCalled();
  });
});
