import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';
import {
  MemoryApprovalController,
  MemoryApprovalGrantController,
  MemoryRejectionGrantController,
  MemoryVerifiedRevocationGrantController,
} from '../src/memory/memory-approval.controller.js';
import { MemoryApprovalService } from '../src/memory/memory-approval.service.js';

const secret = 'local-memory-approval-operator-secret-32-bytes-long';
const repository = 'sauron9521/gym-dev-hub';
const recordId = randomUUID();
const sourceId = randomUUID();
const agentId = randomUUID();
const taskId = randomUUID();
const sessionId = randomUUID();
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_REJECTION_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_VERIFIED_REVOCATION_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_SECRET: secret,
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repository,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
  DEV_HUB_MEMORY_DATABASE_URL:
    'postgresql://gym_dev_hub:fixture@127.0.0.1:55441/gym_dev_hub_memory',
};
const auth = new MemoryAuthorizationService(env);
let status = 'PROPOSED';
let revision = 1;
let verifiedAt: Date | null = null;
let sourceRef = 'agent-session:source-evidence';
let auditCount = 0;
const sql = vi.fn(async (statement: string) => {
  if (statement.includes('FROM memory_records r')) {
    const expected = statement.includes("r.status='VERIFIED'") ? 'VERIFIED' : 'PROPOSED';
    return {
      rows:
        status === expected
          ? [
              {
                id: recordId,
                repository,
                kind: 'DECISION',
                scope: 'SESSION',
                status,
                revision,
                text: 'Review this untrusted agent suggestion',
                session_id: sessionId,
                agent_id: agentId,
                task_id: taskId,
                source_id: sourceId,
                source_ref: sourceRef,
                verified_by: status === 'VERIFIED' ? 'local-operator' : null,
                verified_at: verifiedAt,
              },
            ]
          : [],
    };
  }
  if (statement.includes('UPDATE memory_records')) {
    const isVerifiedRevoke = statement.includes("status='VERIFIED' AND scope='SESSION'");
    if (isVerifiedRevoke) {
      if (status !== 'VERIFIED' || revision !== 2) return { rowCount: 0, rows: [] };
      status = 'REVOKED';
      revision = 3;
      return { rowCount: 1, rows: [{ revision, verified_at: new Date() }] };
    }
    if (status !== 'PROPOSED' || revision !== 1) return { rowCount: 0, rows: [] };
    status = statement.includes("status='REVOKED'") ? 'REVOKED' : 'VERIFIED';
    revision = 2;
    if (status === 'VERIFIED') verifiedAt = new Date();
    return { rowCount: 1, rows: [{ revision, verified_at: verifiedAt ?? new Date() }] };
  }
  if (statement.includes('INSERT INTO memory_mutation_audit')) auditCount++;
  return { rows: [], rowCount: 1 };
});
const fakeClient = { query: sql, release: vi.fn() };
const pool = { connect: async () => fakeClient, query: sql, end: vi.fn() } as unknown as pg.Pool;
const service = new MemoryApprovalService(auth, env, () => pool);

@Module({
  controllers: [
    MemoryApprovalGrantController,
    MemoryRejectionGrantController,
    MemoryVerifiedRevocationGrantController,
    MemoryApprovalController,
  ],
  providers: [{ provide: MemoryApprovalService, useValue: service }],
})
class TestModule {}

describe('Nest operator approval two-step HTTP (local-only)', () => {
  let app: INestApplication;
  let url: string;
  const base = '/v1/memory';
  const commonHeaders = {
    origin: 'http://127.0.0.1:3100',
    'content-type': 'application/json',
    'x-dev-hub-memory-operator-secret': secret,
  };
  const reviewBody = { repository, recordId, expectedRevision: 1 };
  const post = (path: string, body: unknown, headers = commonHeaders) =>
    fetch(url + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  const review = () => post(base + '/operator/approval-grants', reviewBody);

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    if (app) await app.close();
  });
  beforeEach(() => {
    status = 'PROPOSED';
    revision = 1;
    verifiedAt = null;
    sourceRef = 'agent-session:source-evidence';
    auditCount = 0;
    sql.mockClear();
  });

  it('allows two explicit local operator actions; no bearer is ever promoted to approval', async () => {
    const first = await review();
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const prepared = (await first.json()) as {
      recordId: string;
      grantId: string;
      grantToken: string;
      fingerprint: string;
      expectedRevision: number;
      preview: { text: string; sourceRef: string; kind: string };
    };
    expect(prepared).toMatchObject({
      recordId,
      expectedRevision: 1,
      preview: {
        text: 'Review this untrusted agent suggestion',
        sourceRef: 'agent-session:source-evidence',
        kind: 'decision',
      },
    });
    expect(prepared.grantToken).toHaveLength(43);
    expect(prepared.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const headers = { ...commonHeaders, 'x-dev-hub-memory-approval-grant': prepared.grantToken };
    const target = base + '/' + recordId + '/approve';
    const second = await post(
      target,
      {
        repository,
        expectedRevision: 1,
        fingerprint: prepared.fingerprint,
      },
      headers,
    );
    expect(second.status).toBe(200);
    expect(second.headers.get('cache-control')).toBe('no-store');
    expect(await second.json()).toEqual({ recordId, status: 'VERIFIED', revision: 2 });
    expect(auditCount).toBe(1);
    expect(sql.mock.calls.map(([q]) => q).join('\n')).toContain('FOR UPDATE OF r');
    const replay = await post(
      target,
      {
        repository,
        expectedRevision: 1,
        fingerprint: prepared.fingerprint,
      },
      headers,
    );
    expect(replay.status).toBe(403);
    expect(auditCount).toBe(1);
  });

  it('never allows agent bearer, anonymous, malformed JSON body, bad origin or query to issue grants', async () => {
    const agentToken = auth.provisionReadCredential(secret, {
      kind: 'agent',
      repository,
      taskId,
      agentId,
      sessionId,
      ttlSeconds: 60,
    });
    sql.mockClear();
    const attempts = [
      {
        headers: { ...commonHeaders, authorization: 'Bearer ' + agentToken.bearerToken },
        expected: 403,
      },
      { headers: { ...commonHeaders, 'x-dev-hub-memory-operator-secret': 'wrong' }, expected: 401 },
      { headers: { ...commonHeaders, origin: 'http://evil.example' }, expected: 403 },
      { headers: { ...commonHeaders, 'sec-fetch-site': 'cross-site' }, expected: 403 },
      { headers: { ...commonHeaders, 'content-type': 'text/plain' }, expected: 403 },
    ];
    for (const entry of attempts) {
      const result = await post(base + '/operator/approval-grants', reviewBody, entry.headers);
      expect(result.status).toBe(entry.expected);
    }
    expect(
      (await post(base + '/operator/approval-grants?grant_token=secret', reviewBody)).status,
    ).toBe(403);
    expect(
      (
        await post(base + '/operator/approval-grants', {
          ...reviewBody,
          operatorId: 'forged',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(base + '/operator/approval-grants', {
          ...reviewBody,
          expectedRevision: 2,
        })
      ).status,
    ).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('burns a wrong-fingerprint or wrong-target grant without DB mutation', async () => {
    const prepared = (await (await review()).json()) as { fingerprint: string; grantToken: string };
    sql.mockClear();
    const headers = { ...commonHeaders, 'x-dev-hub-memory-approval-grant': prepared.grantToken };
    const target = base + '/' + recordId + '/approve';
    const wrong = await post(
      target,
      {
        repository,
        expectedRevision: 1,
        fingerprint: 'sha256:' + '0'.repeat(64),
      },
      headers,
    );
    expect(wrong.status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
    expect(
      (
        await post(
          target,
          {
            repository,
            expectedRevision: 1,
            fingerprint: prepared.fingerprint,
          },
          headers,
        )
      ).status,
    ).toBe(403);
    expect(status).toBe('PROPOSED');
  });

  it('rejects stale reviewed source even when an operator grant was previously issued', async () => {
    const prepared = (await (await review()).json()) as { fingerprint: string; grantToken: string };
    sourceRef = 'agent-session:modified-evidence';
    const response = await post(
      base + '/' + recordId + '/approve',
      {
        repository,
        expectedRevision: 1,
        fingerprint: prepared.fingerprint,
      },
      { ...commonHeaders, 'x-dev-hub-memory-approval-grant': prepared.grantToken },
    );
    expect(response.status).toBe(409);
    expect(status).toBe('PROPOSED');
    expect(auditCount).toBe(0);
  });

  it('reviews, rejects and permanently consumes only a REJECT_MEMORY_PROPOSAL grant', async () => {
    const grantResponse = await post(base + '/operator/rejection-grants', reviewBody);
    expect(grantResponse.status).toBe(201);
    expect(grantResponse.headers.get('cache-control')).toBe('no-store');
    const prepared = (await grantResponse.json()) as {
      grantToken: string;
      grantId: string;
      fingerprint: string;
      action: string;
      preview: { text: string; sourceRef: string };
    };
    expect(prepared).toMatchObject({
      action: 'REJECT_MEMORY_PROPOSAL',
      preview: {
        text: 'Review this untrusted agent suggestion',
        sourceRef: 'agent-session:source-evidence',
      },
    });
    const headers = { ...commonHeaders, 'x-dev-hub-memory-approval-grant': prepared.grantToken };
    const target = base + '/' + recordId + '/reject';
    const input = { repository, expectedRevision: 1, fingerprint: prepared.fingerprint };
    const rejected = await post(target, input, headers);
    expect(rejected.status).toBe(200);
    expect(rejected.headers.get('cache-control')).toBe('no-store');
    expect(await rejected.json()).toEqual({ recordId, status: 'REVOKED', revision: 2 });
    expect(auditCount).toBe(1);
    expect(status).toBe('REVOKED');
    expect((await post(target, input, headers)).status).toBe(403);
    expect(auditCount).toBe(1);
  });

  it('cannot exchange approval and rejection grants across operator actions', async () => {
    const approval = (await (await review()).json()) as { grantToken: string; fingerprint: string };
    sql.mockClear();
    const wrong = await post(
      base + '/' + recordId + '/reject',
      {
        repository,
        expectedRevision: 1,
        fingerprint: approval.fingerprint,
      },
      { ...commonHeaders, 'x-dev-hub-memory-approval-grant': approval.grantToken },
    );
    expect(wrong.status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
    expect(
      (
        await post(
          base + '/' + recordId + '/approve',
          {
            repository,
            expectedRevision: 1,
            fingerprint: approval.fingerprint,
          },
          { ...commonHeaders, 'x-dev-hub-memory-approval-grant': approval.grantToken },
        )
      ).status,
    ).toBe(403);

    const rejection = (await (
      await post(base + '/operator/rejection-grants', reviewBody)
    ).json()) as { grantToken: string; fingerprint: string };
    sql.mockClear();
    const inverse = await post(
      base + '/' + recordId + '/approve',
      {
        repository,
        expectedRevision: 1,
        fingerprint: rejection.fingerprint,
      },
      { ...commonHeaders, 'x-dev-hub-memory-approval-grant': rejection.grantToken },
    );
    expect(inverse.status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
    expect(
      (
        await post(
          base + '/' + recordId + '/reject',
          {
            repository,
            expectedRevision: 1,
            fingerprint: rejection.fingerprint,
          },
          { ...commonHeaders, 'x-dev-hub-memory-approval-grant': rejection.grantToken },
        )
      ).status,
    ).toBe(403);
    expect(status).toBe('PROPOSED');
  });

  it('independently disables rejection while leaving approval grant reviews available', async () => {
    env.DEV_HUB_MEMORY_REJECTION_HTTP_ENABLE = 'false';
    try {
      expect((await post(base + '/operator/rejection-grants', reviewBody)).status).toBe(503);
      expect((await review()).status).toBe(201);
    } finally {
      env.DEV_HUB_MEMORY_REJECTION_HTTP_ENABLE = 'true';
    }
    // Changing an independent opt-in invalidates every earlier in-process grant.
    const fresh = (await (await post(base + '/operator/rejection-grants', reviewBody)).json()) as {
      grantToken: string;
      fingerprint: string;
    };
    env.DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE = 'false';
    try {
      expect((await review()).status).toBe(503);
      // Changing either flag revokes existing grants; no silent reuse.
      expect(
        (
          await post(
            base + '/' + recordId + '/reject',
            {
              repository,
              expectedRevision: 1,
              fingerprint: fresh.fingerprint,
            },
            { ...commonHeaders, 'x-dev-hub-memory-approval-grant': fresh.grantToken },
          )
        ).status,
      ).toBe(403);
    } finally {
      env.DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE = 'true';
    }
  });

  it('reviews a VERIFIED revision 2, revokes with a distinct action and burns the grant', async () => {
    const approvedGrant = (await (await review()).json()) as {
      grantToken: string;
      fingerprint: string;
    };
    const approved = await post(
      base + '/' + recordId + '/approve',
      { repository, expectedRevision: 1, fingerprint: approvedGrant.fingerprint },
      { ...commonHeaders, 'x-dev-hub-memory-approval-grant': approvedGrant.grantToken },
    );
    expect(approved.status).toBe(200);
    expect(status).toBe('VERIFIED');
    expect(revision).toBe(2);
    const response = await post(base + '/operator/revocation-grants', {
      repository,
      recordId,
      expectedRevision: 2,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const grant = (await response.json()) as {
      grantToken: string;
      grantId: string;
      fingerprint: string;
      action: string;
      preview: { text: string; sourceRef: string };
    };
    expect(grant.action).toBe('REVOKE_MEMORY_RECORD');
    expect(grant.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(grant.preview.text).toBe('Review this untrusted agent suggestion');
    const headers = { ...commonHeaders, 'x-dev-hub-memory-approval-grant': grant.grantToken };
    const body = { repository, expectedRevision: 2, fingerprint: grant.fingerprint };
    const revoked = await post(base + '/' + recordId + '/revoke', body, headers);
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get('cache-control')).toBe('no-store');
    expect(await revoked.json()).toEqual({ recordId, status: 'REVOKED', revision: 3 });
    expect(auditCount).toBe(2);
    expect((await post(base + '/' + recordId + '/revoke', body, headers)).status).toBe(403);
    expect(
      (
        await post(base + '/operator/revocation-grants', {
          repository,
          recordId,
          expectedRevision: 2,
        })
      ).status,
    ).toBe(409);
  });

  it('refuses premature revocation, bad revisions, agent bearer and cross-action grants', async () => {
    const badRev = await post(base + '/operator/revocation-grants', {
      repository,
      recordId,
      expectedRevision: 1,
    });
    expect(badRev.status).toBe(400);
    expect(
      (
        await post(base + '/operator/revocation-grants', {
          repository,
          recordId,
          expectedRevision: 2,
        })
      ).status,
    ).toBe(409);
    const proposedGrant = (await (await review()).json()) as {
      fingerprint: string;
      grantToken: string;
    };
    sql.mockClear();
    const wrong = await post(
      base + '/' + recordId + '/revoke',
      { repository, expectedRevision: 2, fingerprint: proposedGrant.fingerprint },
      { ...commonHeaders, 'x-dev-hub-memory-approval-grant': proposedGrant.grantToken },
    );
    expect(wrong.status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
    expect(
      (
        await post(
          base + '/' + recordId + '/approve',
          { repository, expectedRevision: 1, fingerprint: proposedGrant.fingerprint },
          { ...commonHeaders, 'x-dev-hub-memory-approval-grant': proposedGrant.grantToken },
        )
      ).status,
    ).toBe(403);
    const agent = auth.provisionReadCredential(secret, {
      kind: 'agent',
      repository,
      agentId,
      taskId,
      sessionId,
      ttlSeconds: 60,
    });
    expect(
      (
        await post(
          base + '/operator/revocation-grants',
          { repository, recordId, expectedRevision: 2 },
          { ...commonHeaders, authorization: 'Bearer ' + agent.bearerToken },
        )
      ).status,
    ).toBe(403);
    env.DEV_HUB_MEMORY_VERIFIED_REVOCATION_HTTP_ENABLE = 'false';
    try {
      expect(
        (
          await post(base + '/operator/revocation-grants', {
            repository,
            recordId,
            expectedRevision: 2,
          })
        ).status,
      ).toBe(503);
      expect((await review()).status).toBe(201);
    } finally {
      env.DEV_HUB_MEMORY_VERIFIED_REVOCATION_HTTP_ENABLE = 'true';
    }
  });

  it('remains default-off and supports grant revocation before approval', async () => {
    env.DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE = 'false';
    try {
      expect((await review()).status).toBe(503);
    } finally {
      env.DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE = 'true';
    }
    const prepared = (await (await review()).json()) as {
      grantId: string;
      grantToken: string;
      fingerprint: string;
    };
    auth.revokeOperatorGrant(secret, prepared.grantId);
    const response = await post(
      base + '/' + recordId + '/approve',
      {
        repository,
        expectedRevision: 1,
        fingerprint: prepared.fingerprint,
      },
      { ...commonHeaders, 'x-dev-hub-memory-approval-grant': prepared.grantToken },
    );
    expect(response.status).toBe(403);
    expect(auditCount).toBe(0);
  });
});
