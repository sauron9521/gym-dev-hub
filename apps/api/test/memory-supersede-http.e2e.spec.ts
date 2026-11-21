import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryApprovalService } from '../src/memory/memory-approval.service.js';
import {
  MemorySupersedeController,
  MemorySupersedeGrantController,
} from '../src/memory/memory-supersede.controller.js';
import { MemorySupersedeService } from '../src/memory/memory-supersede.service.js';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';

const repository = 'sauron9521/gym-dev-hub';
const operatorSecret = 'operator-secret-for-memory-supersede-32bytes';
const originalId = randomUUID();
const replacementId = randomUUID();
const taskId = randomUUID(),
  sessionId = randomUUID(),
  agentId = randomUUID();
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_SUPERSEDE_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_SECRET: operatorSecret,
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repository,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
  DEV_HUB_MEMORY_DATABASE_URL:
    'postgresql://gym_dev_hub:fixture@127.0.0.1:55441/gym_dev_hub_memory',
};
const auth = new MemoryAuthorizationService(env);
const verifiedAt = new Date('2026-11-21T12:00:00.000Z');
let superseded = false,
  audited = 0;
const sql = vi.fn(async (query: string, params?: unknown[]) => {
  if (query.includes('FROM memory_records r')) {
    const id = params?.[1];
    if (id !== originalId && id !== replacementId) return { rows: [], rowCount: 0 };
    if (superseded && id === originalId) return { rows: [], rowCount: 0 };
    return {
      rows: [
        {
          id,
          repository,
          kind: 'DECISION',
          scope: 'SESSION',
          status: 'VERIFIED',
          revision: 2,
          text:
            id === originalId
              ? 'Previously verified decision'
              : 'Independently verified new decision',
          task_id: taskId,
          agent_id: agentId,
          session_id: sessionId,
          source_id: id === originalId ? randomUUIDForOld : randomUUIDForNew,
          source_ref: id === originalId ? 'agent-session:original' : 'agent-session:replacement',
          verified_by: 'local-operator',
          verified_at: verifiedAt,
          superseded_by_id: null,
          expires_at: null,
        },
      ],
      rowCount: 1,
    };
  }
  if (query.includes('SELECT id FROM memory_records WHERE repository=$1 AND superseded_by_id')) {
    return { rows: [], rowCount: 0 };
  }
  if (query.includes('SELECT id FROM memory_records') && query.includes('FOR UPDATE'))
    return { rows: [{ id: params?.[1] }], rowCount: 1 };
  if (query.includes('UPDATE memory_records')) {
    if (superseded) return { rows: [], rowCount: 0 };
    superseded = true;
    return { rows: [{ revision: 3, changed_at: new Date() }], rowCount: 1 };
  }
  if (query.includes('INSERT INTO memory_mutation_audit')) audited++;
  return { rows: [], rowCount: 1 };
});
const randomUUIDForOld = randomUUID(),
  randomUUIDForNew = randomUUID();
const fakeClient = { query: sql, release: vi.fn() };
const pool = { query: sql, connect: async () => fakeClient, end: vi.fn() } as unknown as pg.Pool;
const supersede = new MemorySupersedeService(auth, env, () => pool);
const boundary = new MemoryApprovalService(auth, env, () => pool);

@Module({
  controllers: [MemorySupersedeGrantController, MemorySupersedeController],
  providers: [
    { provide: MemorySupersedeService, useValue: supersede },
    { provide: MemoryApprovalService, useValue: boundary },
  ],
})
class TestModule {}

describe('local-only operator memory supersede HTTP', () => {
  let app: INestApplication;
  let url: string;
  const common = {
    origin: 'http://127.0.0.1:3100',
    'content-type': 'application/json',
    'x-dev-hub-memory-operator-secret': operatorSecret,
  };
  const review = {
    repository,
    recordId: originalId,
    replacementRecordId: replacementId,
    expectedRevision: 2,
  };
  const post = (path: string, data: unknown, headers = common) =>
    fetch(url + path, { method: 'POST', headers, body: JSON.stringify(data), redirect: 'manual' });
  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    if (app) await app.close();
  });
  beforeEach(() => {
    superseded = false;
    audited = 0;
    sql.mockClear();
  });

  it('requires explicit review of both records then one-use terminal CAS supersession', async () => {
    const response = await post('/v1/memory/operator/supersede-grants', review);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const prepared = (await response.json()) as {
      action: string;
      grantToken: string;
      grantId: string;
      fingerprint: string;
      preview: { original: { text: string }; replacement: { text: string } };
    };
    expect(prepared.action).toBe('SUPERSEDE_MEMORY_RECORD');
    expect(prepared.preview.original.text).toBe('Previously verified decision');
    expect(prepared.preview.replacement.text).toBe('Independently verified new decision');
    expect(prepared.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const headers = { ...common, 'x-dev-hub-memory-approval-grant': prepared.grantToken };
    const body = {
      repository,
      replacementRecordId: replacementId,
      expectedRevision: 2,
      fingerprint: prepared.fingerprint,
    };
    const committed = await post('/v1/memory/' + originalId + '/supersede', body, headers);
    expect(committed.status).toBe(200);
    expect(committed.headers.get('cache-control')).toBe('no-store');
    expect(await committed.json()).toEqual({
      recordId: originalId,
      status: 'SUPERSEDED',
      revision: 3,
      supersededById: replacementId,
    });
    expect(audited).toBe(1);
    expect(superseded).toBe(true);
    expect((await post('/v1/memory/' + originalId + '/supersede', body, headers)).status).toBe(403);
    expect((await post('/v1/memory/operator/supersede-grants', review)).status).toBe(409);
    expect(audited).toBe(1);
  });

  it('refuses wrong origin, agent bearer, no operator, cross-site and URL credentials before DB', async () => {
    const agent = auth.provisionReadCredential(operatorSecret, {
      kind: 'agent',
      repository,
      taskId,
      sessionId,
      agentId,
      ttlSeconds: 60,
    });
    sql.mockClear();
    for (const headers of [
      { ...common, origin: 'http://evil.example' },
      { ...common, 'sec-fetch-site': 'cross-site' },
      { ...common, authorization: 'Bearer ' + agent.bearerToken },
      { ...common, 'x-dev-hub-memory-operator-secret': 'invalid' },
      { ...common, 'content-type': 'text/plain' },
    ]) {
      const response = await post('/v1/memory/operator/supersede-grants', review, headers);
      expect([401, 403]).toContain(response.status);
    }
    expect((await post('/v1/memory/operator/supersede-grants?token=bad', review)).status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
  });

  it('strictly validates replacement and does not allow agent-selected actor or revision', async () => {
    expect(
      (await post('/v1/memory/operator/supersede-grants', { ...review, expectedRevision: 3 }))
        .status,
    ).toBe(400);
    expect(
      (await post('/v1/memory/operator/supersede-grants', { ...review, operatorId: 'forged' }))
        .status,
    ).toBe(400);
    expect(
      (
        await post('/v1/memory/operator/supersede-grants', {
          ...review,
          replacementRecordId: originalId,
        })
      ).status,
    ).toBe(409);
    const grant = (await (await post('/v1/memory/operator/supersede-grants', review)).json()) as {
      grantToken: string;
      fingerprint: string;
    };
    const headers = { ...common, 'x-dev-hub-memory-approval-grant': grant.grantToken };
    const wrong = await post(
      '/v1/memory/' + originalId + '/supersede',
      {
        repository,
        expectedRevision: 2,
        replacementRecordId: randomUUID(),
        fingerprint: grant.fingerprint,
      },
      headers,
    );
    expect(wrong.status).toBe(409);
    expect(superseded).toBe(false);
    expect(
      (
        await post(
          '/v1/memory/' + originalId + '/supersede',
          {
            repository,
            expectedRevision: 2,
            replacementRecordId: replacementId,
            fingerprint: grant.fingerprint,
          },
          headers,
        )
      ).status,
    ).toBe(403);
  });

  it('is independently disabled by default and does not grant approval/rejection', async () => {
    env.DEV_HUB_MEMORY_SUPERSEDE_HTTP_ENABLE = 'false';
    try {
      expect((await post('/v1/memory/operator/supersede-grants', review)).status).toBe(503);
      expect(
        (
          await post('/v1/memory/' + originalId + '/supersede', {
            repository,
            expectedRevision: 2,
            replacementRecordId: replacementId,
            fingerprint: 'sha256:' + '0'.repeat(64),
          })
        ).status,
      ).toBe(503);
      expect(sql).not.toHaveBeenCalled();
    } finally {
      env.DEV_HUB_MEMORY_SUPERSEDE_HTTP_ENABLE = 'true';
    }
  });
});
