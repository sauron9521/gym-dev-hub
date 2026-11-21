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
const taskIdentity = randomUUID();
const sessionIdentity = randomUUID();
const authorization = new MemoryAuthorizationService(env);
const issued = authorization.provisionReadCredential(secret, {
  kind: 'agent',
  repository,
  agentId: identity,
  taskId: taskIdentity,
  sessionId: sessionIdentity,
  ttlSeconds: 600,
});
const valid = {
  repository_exists: true,
  task_exists: true,
  agent_exists: true,
  session_exists: true,
  membership_exists: true,
};
const memoryId = randomUUID();
const sourceId = randomUUID();
const revisionId = randomUUID();
const now = new Date();
const visibleRecord = {
  id: memoryId,
  repository,
  scope: 'PROJECT',
  kind: 'DECISION',
  status: 'VERIFIED',
  text: 'approved decision for the current repository',
  revision: 2,
  task_id: null,
  session_id: null,
  agent_id: null,
  source_sha: null,
  superseded_by_id: null,
  expires_at: null,
  verified_by: 'operator',
  verified_at: now,
  created_at: now,
  updated_at: now,
  provenance_id: sourceId,
  source_type: 'HUMAN',
  actor_id: 'operator',
  source_ref: 'local-human-approval',
  provenance_source_sha: null,
  observed_at: now,
  provenance_created_at: now,
};
const visibleRevision = {
  id: revisionId,
  repository,
  memory_id: memoryId,
  revision: 2,
  scope: 'PROJECT',
  kind: 'DECISION',
  status: 'VERIFIED',
  text: visibleRecord.text,
  source_sha: null,
  source_id: sourceId,
  changed_by: 'operator',
  created_at: now,
};
let showVisibleRecord = false;
let dbResult: 'success' | 'foreign' | 'error' = 'success';
const query = vi.fn(async (sql: string) => {
  if (dbResult === 'error') throw new Error('private PostgreSQL password should not escape');
  if (sql.includes('memory_repositories'))
    return { rows: [{ ...valid, ...(dbResult === 'foreign' ? { agent_exists: false } : {}) }] };
  if (sql.includes('FROM memory_revisions'))
    return { rows: showVisibleRecord ? [visibleRevision] : [] };
  if (sql.includes('r.id=$8::uuid LIMIT 1'))
    return { rows: showVisibleRecord ? [visibleRecord] : [] };
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
      taskId: taskIdentity,
      sessionId: sessionIdentity,
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

  it('rejects invalid cursor; unknown detail and revisions are uniformly 404', async () => {
    const response = await request(path + '&cursor=not-a-valid-cursor');
    expect(response.status).toBe(400);
    for (const route of ['/v1/memory/' + randomUUID(), '/v1/memory/' + randomUUID() + '/revisions'])
      expect((await request(route + '?' + new URLSearchParams({ repository }))).status).toBe(404);
  });

  it('returns only a visible verified detail and its bounded verified revision snapshots', async () => {
    const detailPath = '/v1/memory/' + memoryId + '?' + new URLSearchParams({ repository });
    showVisibleRecord = true;
    query.mockClear();
    try {
      const detail = await request(detailPath);
      expect(detail.status).toBe(200);
      expect(detail.headers.get('cache-control')).toBe('no-store');
      expect(detail.headers.get('referrer-policy')).toBe('no-referrer');
      const data = (await detail.json()) as {
        record: { id: string; status: string; text: string };
        provenance: { memoryId: string };
      };
      expect(data.record).toMatchObject({
        id: memoryId,
        status: 'verified',
        text: visibleRecord.text,
      });
      expect(data.provenance.memoryId).toBe(memoryId);
      const detailsSql = query.mock.calls.map(([sql]) => sql);
      expect(detailsSql[0]).toContain('memory_repositories');
      expect(detailsSql[1]).toContain("r.status='VERIFIED'");
      expect(detailsSql[1]).toContain('r.id=$8::uuid LIMIT 1');

      query.mockClear();
      const history = await request(detailPath.replace('?', '/revisions?'));
      expect(history.status).toBe(200);
      expect(history.headers.get('cache-control')).toBe('no-store');
      const revisions = (await history.json()) as {
        memoryId: string;
        revisions: { revision: number; status: string }[];
      };
      expect(revisions).toMatchObject({
        memoryId,
        revisions: [{ revision: 2, status: 'verified' }],
      });
      const revisionSql = query.mock.calls.map(([sql]) => sql);
      expect(revisionSql[0]).toContain('memory_repositories');
      expect(revisionSql[1]).toContain('r.id=$8::uuid LIMIT 1');
      expect(revisionSql[2]).toContain("status='VERIFIED'");
      expect(revisionSql[2]).toContain('LIMIT 100');
    } finally {
      showVisibleRecord = false;
    }
  });

  it('forbids foreign/malformed detail scope and ID, including unexpected query params, before DB', async () => {
    factory.mockClear();
    for (const suffix of ['', '/revisions']) {
      const route = '/v1/memory/' + memoryId + suffix;
      for (const bad of [
        route, // missing repository
        route + '?repository=bad',
        '/v1/memory/not-a-uuid' + suffix + '?' + new URLSearchParams({ repository }),
        route + '?' + new URLSearchParams({ repository }) + '&taskId=' + randomUUID(),
        route + '?' + new URLSearchParams({ repository }) + '&cursor=forbidden',
      ])
        expect((await request(bad)).status).toBe(400);
      const foreign = await request(route + '?repository=sauron9521/gym-platform');
      expect(foreign.status).toBe(404);
      const anonymous = await request(route + '?' + new URLSearchParams({ repository }), {
        origin: 'http://127.0.0.1:3100',
      });
      expect(anonymous.status).toBe(401);
      const spoofedOrigin = await request(route + '?' + new URLSearchParams({ repository }), {
        ...headers,
        origin: 'https://attacker.example',
      });
      expect(spoofedOrigin.status).toBe(403);
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('checks revoked bearer and unregistered identity for both detail and revisions', async () => {
    const token = authorization.provisionReadCredential(secret, {
      kind: 'agent',
      repository,
      agentId: identity,
      taskId: taskIdentity,
      sessionId: sessionIdentity,
      ttlSeconds: 60,
    });
    authorization.revokeCredential(secret, token.credentialId);
    for (const suffix of ['', '/revisions']) {
      const route = '/v1/memory/' + memoryId + suffix + '?' + new URLSearchParams({ repository });
      const revoked = await request(route, {
        ...headers,
        authorization: 'Bearer ' + token.bearerToken,
      });
      expect(revoked.status).toBe(401);
      dbResult = 'foreign';
      expect((await request(route)).status).toBe(403);
      dbResult = 'error';
      const unavailable = await request(route);
      expect(unavailable.status).toBe(503);
      expect(JSON.stringify(await unavailable.json())).not.toContain('private PostgreSQL password');
      dbResult = 'success';
    }
  });

  it('reserved status stays 503 rather than being treated as a record ID', async () => {
    expect((await request('/v1/memory/status')).status).toBe(503);
  });

  it('defaults to 503 without independent read flag, even with valid bearer', async () => {
    factory.mockClear();
    env.DEV_HUB_MEMORY_READ_HTTP_ENABLE = 'false';
    try {
      const response = await request();
      expect(response.status).toBe(503);
      for (const suffix of ['', '/revisions']) {
        const detail = await request(
          '/v1/memory/' + memoryId + suffix + '?' + new URLSearchParams({ repository }),
        );
        expect(detail.status).toBe(503);
      }
      expect(factory).not.toHaveBeenCalled();
    } finally {
      env.DEV_HUB_MEMORY_READ_HTTP_ENABLE = 'true';
    }
  });
});
