import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';
import { MemoryOperatorIdentityController } from '../src/security/memory-operator-identity.controller.js';
import { MemoryOperatorIdentityService } from '../src/security/memory-operator-identity.service.js';

const root = 'local-only-operator-root-secret-for-tests-48bytes';
const repository = 'sauron9521/gym-dev-hub';
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_IDENTITIES_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repository,
  DEV_HUB_MEMORY_OPERATOR_SECRET: root,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
  DEV_HUB_MEMORY_DATABASE_URL:
    'postgresql://gym_dev_hub:fixture@127.0.0.1:55441/gym_dev_hub_memory',
};
type Row = {
  id: string;
  repository: string;
  handle: string;
  role: 'AUDITOR' | 'REVIEWER';
  expires_at: Date;
  revoked_at: Date | null;
  token_digest: string;
};
const identities = new Map<string, Row>();
let audits = 0;
const sql = vi.fn(async (statement: string, params: unknown[] = []) => {
  if (statement.includes('INSERT INTO memory_operator_identities')) {
    const [repo, handle, role, hash, ttl] = params as [
      string,
      string,
      'AUDITOR' | 'REVIEWER',
      string,
      number,
    ];
    if ([...identities.values()].some((r) => r.repository === repo && r.handle === handle))
      throw Object.assign(Error('fixture duplicate'), { code: '23505' });
    const row = {
      id: randomUUID(),
      repository: repo,
      handle,
      role,
      token_digest: hash,
      expires_at: new Date(Date.now() + ttl * 1000),
      revoked_at: null,
    };
    identities.set(hash, row);
    return { rows: [row], rowCount: 1 };
  }
  if (statement.includes('SELECT id,repository,handle,role,expires_at,revoked_at')) {
    const [repo, hash] = params as [string, string];
    const row = identities.get(hash);
    const valid =
      row && row.repository === repo && !row.revoked_at && row.expires_at.getTime() > Date.now();
    return { rows: valid ? [row] : [], rowCount: valid ? 1 : 0 };
  }
  if (statement.includes('UPDATE memory_operator_identities SET revoked_at')) {
    const [repo, id] = params as [string, string];
    const row = [...identities.values()].find(
      (x) => x.repository === repo && x.id === id && !x.revoked_at,
    );
    if (row) row.revoked_at = new Date();
    return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
  }
  if (statement.includes('INSERT INTO memory_operator_identity_audit')) audits++;
  return { rows: [], rowCount: 1 };
});
const client = { query: sql, release: vi.fn() };
const pool = { query: sql, connect: async () => client, end: vi.fn() } as unknown as pg.Pool;
const auth = new MemoryAuthorizationService(env);
const service = new MemoryOperatorIdentityService(auth, env, () => pool);
@Module({
  controllers: [MemoryOperatorIdentityController],
  providers: [{ provide: MemoryOperatorIdentityService, useValue: service }],
})
class TestModule {}

describe('operator identities HTTP auth boundary', () => {
  let app: INestApplication, url: string;
  const base = '/v1/memory/operator/identities';
  const headers = {
    origin: 'http://127.0.0.1:3100',
    'content-type': 'application/json',
    'x-dev-hub-memory-operator-secret': root,
  };
  const post = (path: string, body: unknown, h: Record<string, string> = headers) =>
    fetch(url + path, {
      method: 'POST',
      headers: h,
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
  beforeEach(() => {
    identities.clear();
    audits = 0;
    sql.mockClear();
  });

  it('issues one secret once, authenticates its holder, revokes and never caches', async () => {
    const issued = await post(base, {
      repository,
      handle: 'alice_reviewer',
      role: 'REVIEWER',
      ttlSeconds: 120,
    });
    expect(issued.status).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    const user = (await issued.json()) as { identityId: string; bearerToken: string };
    expect(user.bearerToken).toMatch(/^mop_[A-Za-z0-9_-]{43}$/);
    expect(audits).toBe(1);
    const bearer = {
      origin: headers.origin,
      'content-type': 'application/json',
      authorization: 'Bearer ' + user.bearerToken,
    };
    const me = await post(base + '/whoami', { repository }, bearer);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ identityId: user.identityId, role: 'REVIEWER' });
    const revoked = await post(base + '/' + user.identityId + '/revoke', { repository });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    expect(audits).toBe(2);
    expect((await post(base + '/whoami', { repository }, bearer)).status).toBe(401);
    expect((await post(base + '/' + user.identityId + '/revoke', { repository })).status).toBe(200);
    expect(audits).toBe(2);
  });

  it('rejects spoofed actor, invalid role, wrong origin, cross-site and bearer as root', async () => {
    const data = { repository, handle: 'bob_reviewer', role: 'REVIEWER', ttlSeconds: 120 };
    for (const h of [
      { ...headers, origin: 'http://attacker.example' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
      { ...headers, authorization: 'Bearer ' + 'A'.repeat(43) },
      { ...headers, 'content-type': 'text/plain' },
    ])
      expect((await post(base, data, h)).status).toBe(403);
    expect((await post(base + '?operator=spoof', data)).status).toBe(403);
    expect((await post(base, { ...data, actorId: 'fake' })).status).toBe(400);
    expect((await post(base, { ...data, role: 'SUPERADMIN' })).status).toBe(400);
    expect(
      (await post(base, data, { ...headers, 'x-dev-hub-memory-operator-secret': 'wrong' })).status,
    ).toBe(401);
    expect(audits).toBe(0);
    expect(identities.size).toBe(0);
  });

  it('AUDITOR cannot approve or mint another credential', async () => {
    const response = await post(base, {
      repository,
      handle: 'carol_auditor',
      role: 'AUDITOR',
      ttlSeconds: 300,
    });
    expect(response.status).toBe(201);
    const user = (await response.json()) as { bearerToken: string };
    expect(
      (await service.verify(user.bearerToken, repository, 'READ_OPERATOR_METADATA')).role,
    ).toBe('AUDITOR');
    await expect(
      service.verify(user.bearerToken, repository, 'APPROVE_MEMORY_PROPOSAL'),
    ).rejects.toMatchObject({ status: 403 });
    const bearer = {
      origin: headers.origin,
      'content-type': 'application/json',
      authorization: 'Bearer ' + user.bearerToken,
    };
    expect(
      (await post(base, { repository, handle: 'fake', role: 'REVIEWER', ttlSeconds: 60 }, bearer))
        .status,
    ).toBe(403);
    expect(
      (
        await post(
          base + '/whoami',
          { repository },
          { ...headers, authorization: 'Bearer ' + user.bearerToken },
        )
      ).status,
    ).toBe(403);
  });

  it('default-off identity routes return 503 and never query database', async () => {
    env.DEV_HUB_MEMORY_OPERATOR_IDENTITIES_HTTP_ENABLE = 'false';
    try {
      expect(
        (await post(base, { repository, handle: 'blocked', role: 'REVIEWER', ttlSeconds: 60 }))
          .status,
      ).toBe(503);
      expect(
        (
          await post(
            base + '/whoami',
            { repository },
            {
              origin: headers.origin,
              'content-type': 'application/json',
              authorization: 'Bearer mop_' + 'A'.repeat(43),
            },
          )
        ).status,
      ).toBe(503);
      expect(sql).not.toHaveBeenCalled();
    } finally {
      env.DEV_HUB_MEMORY_OPERATOR_IDENTITIES_HTTP_ENABLE = 'true';
    }
  });
});
