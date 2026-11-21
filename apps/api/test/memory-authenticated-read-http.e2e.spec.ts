import { randomUUID } from 'node:crypto';
import { request as nodeHttpRequest } from 'node:http';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryController } from '../src/memory/memory.controller.js';
import { MemoryAuthenticatedReadService } from '../src/memory/memory-authenticated-read.service.js';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';

const repository = 'sauron9521/gym-dev-hub';
const secret = 'test-only-memory-operator-secret-over-thirty-two-chars';
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_READ_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_SECRET: secret,
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repository,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
  DEV_HUB_MEMORY_DATABASE_URL:
    'postgresql://gym_dev_hub:fixture-only@127.0.0.1:55441/gym_dev_hub_memory',
};
const identity = randomUUID();
const authorization = new MemoryAuthorizationService(env);
const issued = authorization.provisionReadCredential(secret, {
  kind: 'agent',
  repository,
  agentId: identity,
  ttlSeconds: 600,
});
const valid = {
  repository_exists: true,
  task_exists: true,
  agent_exists: true,
  session_exists: true,
  membership_exists: true,
};
let dbResult: 'success' | 'foreign' | 'error' = 'success';
const query = vi.fn(async (sql: string) => {
  if (dbResult === 'error') throw new Error('private PostgreSQL password should not escape');
  if (sql.includes('memory_repositories'))
    return { rows: [{ ...valid, ...(dbResult === 'foreign' ? { agent_exists: false } : {}) }] };
  return { rows: [] };
});
const end = vi.fn(async () => undefined);
const factory = vi.fn((_url: string) => ({ query, end }) as unknown as pg.Pool);
const reads = new MemoryAuthenticatedReadService(authorization, env, factory);

@Module({
  controllers: [MemoryController],
  providers: [{ provide: MemoryAuthenticatedReadService, useValue: reads }],
})
class TestModule {}

describe('actual Nest GET /v1/memory authorization, opt-in and scope', () => {
  let app: INestApplication;
  let url: string;
  const path = '/v1/memory?' + new URLSearchParams({ repository });
  const headers = {
    authorization: 'Bearer ' + issued.bearerToken,
    origin: 'http://127.0.0.1:3100',
  };
  const request = (target = path, extraHeaders: Record<string, string> = headers) =>
    fetch(url + target, { headers: extraHeaders, redirect: 'manual' });

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it('returns verified-only empty page with no-store; verifies bearer scope before query', async () => {
    query.mockClear();
    factory.mockClear();
    end.mockClear();
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      repository,
      items: [],
      nextCursor: null,
    });
    expect(factory).toHaveBeenCalledOnce();
    const sql = query.mock.calls.map(([statement]) => statement);
    expect(sql[0]).toContain('memory_repositories');
    expect(sql[1]).toContain("r.status='VERIFIED'");
    expect(end).toHaveBeenCalledOnce();
  });

  it('never calls DB for invalid, anonymous or revoked bearer', async () => {
    factory.mockClear();
    for (const authorizationValue of [
      undefined,
      'Bearer invalid',
      'Basic wrong',
      'Bearer ' + 'A'.repeat(43),
    ]) {
      const response = await request(path, {
        origin: 'http://127.0.0.1:3100',
        ...(authorizationValue ? { authorization: authorizationValue } : {}),
      });
      expect(response.status).toBe(401);
    }
    expect(factory).not.toHaveBeenCalled();
    const temporary = authorization.provisionReadCredential(secret, {
      kind: 'agent',
      repository,
      agentId: randomUUID(),
      ttlSeconds: 50,
    });
    authorization.revokeCredential(secret, temporary.credentialId);
    const revokedResponse = await request(path, {
      ...headers,
      authorization: 'Bearer ' + temporary.bearerToken,
    });
    expect(revokedResponse.status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects cross-repository, foreign task and malformed query before DB', async () => {
    factory.mockClear();
    for (const target of [
      '/v1/memory?repository=sauron9521/gym-platform',
      path + '&taskId=' + randomUUID(),
    ])
      expect((await request(target)).status).toBe(404);
    for (const target of [
      '/v1/memory',
      path + '&limit=51',
      path + '&limit=0',
      path + '&unknown=true',
      path + '&repository=another',
    ])
      expect((await request(target)).status).toBe(400);
    expect(factory).not.toHaveBeenCalled();
  });

  it('denies cross-site, unsafe origin and URL token before DB', async () => {
    factory.mockClear();
    for (const [target, extra] of [
      [path, { origin: 'https://evil.example' }],
      [path, { 'sec-fetch-site': 'cross-site' }],
      [path + '&access_token=' + issued.bearerToken, {}],
    ] as const) {
      expect((await request(target, { ...headers, ...extra })).status).toBe(403);
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects spoofed Host via raw HTTP (fetch replaces Host automatically)', async () => {
    factory.mockClear();
    const status = await new Promise<number>((resolve, reject) => {
      const req = nodeHttpRequest(
        url + path,
        { headers: { ...headers, Host: 'attacker.example:3101' } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(factory).not.toHaveBeenCalled();
  });

  it('returns 403 for unregistered DB identity; 503 for DB failures without secrets', async () => {
    dbResult = 'foreign';
    expect((await request()).status).toBe(403);
    dbResult = 'error';
    const response = await request();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('private PostgreSQL password');
    dbResult = 'success';
  });

  it('rejects forged or other-context cursor as 400; detail and revisions stay 503', async () => {
    const response = await request(path + '&cursor=not-a-valid-cursor');
    expect(response.status).toBe(400);
    for (const route of ['/v1/memory/' + randomUUID(), '/v1/memory/' + randomUUID() + '/revisions'])
      expect((await request(route)).status).toBe(503);
  });

  it('defaults to 503 without independent read flag, even with valid bearer', async () => {
    factory.mockClear();
    env.DEV_HUB_MEMORY_READ_HTTP_ENABLE = 'false';
    try {
      const response = await request();
      expect(response.status).toBe(503);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      env.DEV_HUB_MEMORY_READ_HTTP_ENABLE = 'true';
    }
  });
});
