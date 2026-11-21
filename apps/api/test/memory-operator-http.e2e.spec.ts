import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryController } from '../src/memory/memory.controller.js';
import { MemoryAuthenticatedReadService } from '../src/memory/memory-authenticated-read.service.js';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';
import { MemoryOperatorCredentialController } from '../src/security/memory-operator-credential.controller.js';
import { MemoryOperatorCredentialService } from '../src/security/memory-operator-credential.service.js';
import { MemorySecurityError } from '../src/security/memory-security-policy.js';

const repo = 'sauron9521/gym-dev-hub';
const secret = 'operator-only-http-test-secret-long-enough';
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_SECRET: secret,
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repo,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
};
const authorization = new MemoryAuthorizationService(env);
const verifyScope = vi.fn().mockResolvedValue(undefined);
const service = new MemoryOperatorCredentialService(authorization, env, verifyScope);

@Module({
  controllers: [MemoryOperatorCredentialController, MemoryController],
  providers: [
    { provide: MemoryOperatorCredentialService, useValue: service },
    {
      provide: MemoryAuthenticatedReadService,
      useValue: new MemoryAuthenticatedReadService(authorization, env),
    },
  ],
})
class LocalHttpTestModule {}

describe('actual loopback Nest HTTP operator credential isolation', () => {
  let app: INestApplication;
  let url: string;
  const path = '/v1/memory/operator/credentials';
  const issue = () => ({
    kind: 'agent',
    repository: repo,
    agentId: randomUUID(),
    taskId: randomUUID(),
    sessionId: randomUUID(),
    ttlSeconds: 90,
  });
  const headers = {
    origin: 'http://127.0.0.1:3100',
    'content-type': 'application/json',
    'x-dev-hub-memory-operator-secret': secret,
  };
  const request = (target: string, options: RequestInit) =>
    fetch(url + target, { ...options, redirect: 'manual' });

  beforeAll(async () => {
    app = await NestFactory.create(LocalHttpTestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it('real HTTP POST issues scoped read-only bearer, DELETE revokes and cache remains disabled', async () => {
    const created = await request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(issue()),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(created.headers.get('referrer-policy')).toBe('no-referrer');
    const data = (await created.json()) as {
      credentialId: string;
      bearerToken: string;
      permission: string;
    };
    expect(data.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(data.permission).toBe('READ_VERIFIED');
    expect(authorization.authenticateReadBearer(data.bearerToken).type).toBe('agent');

    const revoked = await request(path + '/' + data.credentialId, {
      method: 'DELETE',
      headers,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    expect(() => authorization.authenticateReadBearer(data.bearerToken)).toThrow();
  });

  it('denies missing/wrong operator secret and never calls verifier', async () => {
    verifyScope.mockClear();
    for (const attempt of [
      { ...headers, 'x-dev-hub-memory-operator-secret': '' },
      { ...headers, 'x-dev-hub-memory-operator-secret': 'wrong' },
    ]) {
      const res = await request(path, {
        method: 'POST',
        headers: attempt,
        body: JSON.stringify(issue()),
      });
      expect(res.status).toBe(401);
    }
    expect(verifyScope).not.toHaveBeenCalled();
  });

  it('denies hostile origin, cross-site, URL secrets, wrong content-type and external client scope', async () => {
    for (const attempt of [
      { target: path, headers: { ...headers, origin: 'http://attacker.test' } },
      { target: path, headers: { ...headers, 'sec-fetch-site': 'cross-site' } },
      { target: path + '?token=exposed', headers },
      { target: path, headers: { ...headers, 'content-type': 'text/plain' } },
    ]) {
      const res = await request(attempt.target, {
        method: 'POST',
        headers: attempt.headers,
        body: JSON.stringify(issue()),
      });
      expect(res.status).toBe(403);
    }
    const external = await request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...issue(), kind: 'external' }),
    });
    expect(external.status).toBe(403);
  });

  it('refuses missing task/session or caller-forged scope before any DB query or audit', async () => {
    verifyScope.mockClear();
    const priorEvents = authorization.auditSnapshot().length;
    for (const body of [
      { ...issue(), taskId: undefined },
      { ...issue(), sessionId: undefined },
      { ...issue(), taskId: undefined, sessionId: undefined },
      { ...issue(), agentId: undefined },
      { ...issue(), taskId: 'not-a-uuid' },
    ]) {
      const response = await request(path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(403);
    }
    expect(verifyScope).not.toHaveBeenCalled();
    expect(authorization.auditSnapshot().length).toBe(priorEvents);
  });

  it('turns missing database membership into 403, outage into 503 without leaking its error', async () => {
    verifyScope.mockRejectedValueOnce(new MemorySecurityError('forbidden'));
    // A known membership failure maps to 403 without minting a bearer.
    let response = await request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(issue()),
    });
    expect(response.status).toBe(403);
    verifyScope.mockRejectedValueOnce(new Error('postgres private credentials'));
    response = await request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(issue()),
    });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('postgres private credentials');
  });

  it('continues to block all reserved memory reads despite a valid issued bearer', async () => {
    const created = await request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(issue()),
    });
    expect(created.status).toBe(201);
    const data = (await created.json()) as { bearerToken: string };
    for (const route of [
      '/v1/memory',
      '/v1/memory/' + randomUUID(),
      '/v1/memory/' + randomUUID() + '/revisions',
    ]) {
      const response = await request(route, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + data.bearerToken },
      });
      expect(response.status).toBe(503);
    }
  });
});
