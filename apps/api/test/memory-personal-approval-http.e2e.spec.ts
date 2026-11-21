import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryApprovalService } from '../src/memory/memory-approval.service.js';
import {
  MemoryPersonalApprovalController,
  MemoryPersonalApprovalGrantController,
} from '../src/memory/memory-personal-approval.controller.js';
import { MemoryPersonalApprovalService } from '../src/memory/memory-personal-approval.service.js';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';

const repo = 'sauron9521/gym-dev-hub',
  recordId = randomUUID();
const token = 'mop_' + 'Q'.repeat(43),
  grantToken = 'G'.repeat(43);
const root = 'fixture-memory-root-secret-minimum-32-bytes';
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_IDENTITIES_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_PERSONAL_APPROVAL_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repo,
  DEV_HUB_MEMORY_OPERATOR_SECRET: root,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
};
const reviewBody = { repository: repo, recordId, expectedRevision: 1 };
const commitBody = {
  repository: repo,
  expectedRevision: 1,
  fingerprint: 'sha256:' + 'a'.repeat(64),
};
const personal = {
  reviewAndGrant: vi.fn(async (_bearer: unknown, _data: unknown) => ({
    action: 'APPROVE_MEMORY_PROPOSAL',
    grantToken,
    grantId: randomUUID(),
    recordId,
    expectedRevision: 1,
    fingerprint: commitBody.fingerprint,
    operatorIdentityId: randomUUID(),
    preview: { kind: 'decision', text: 'Untrusted proposal', sourceRef: 'agent-session:source' },
  })),
  approve: vi.fn(async () => ({ recordId, status: 'VERIFIED', revision: 2 })),
};
const boundary = new MemoryApprovalService(new MemoryAuthorizationService(env), env);
@Module({
  controllers: [MemoryPersonalApprovalGrantController, MemoryPersonalApprovalController],
  providers: [
    { provide: MemoryPersonalApprovalService, useValue: personal },
    { provide: MemoryApprovalService, useValue: boundary },
  ],
})
class TestModule {}

describe('personal approval Nest HTTP safety boundary', () => {
  let app: INestApplication, url: string;
  const base = '/v1/memory';
  const goodHeaders = {
    'content-type': 'application/json',
    origin: 'http://127.0.0.1:3100',
    authorization: 'Bearer ' + token,
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = goodHeaders) =>
    fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual' });
  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    if (app) await app.close();
  });
  beforeEach(() => {
    personal.reviewAndGrant.mockClear();
    personal.approve.mockClear();
  });

  it('passes ONLY server-extracted reviewer bearer, returns no-store review and explicit grant route', async () => {
    const response = await post(base + '/operator/personal-approval-grants', reviewBody);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const obj = (await response.json()) as { action: string; preview: { text: string } };
    expect(obj.action).toBe('APPROVE_MEMORY_PROPOSAL');
    expect(obj.preview.text).toBe('Untrusted proposal');
    expect(personal.reviewAndGrant).toHaveBeenCalledWith(token, reviewBody);
    const headers = { ...goodHeaders, 'x-dev-hub-memory-personal-grant': grantToken };
    const committed = await post(base + '/' + recordId + '/personal-approve', commitBody, headers);
    expect(committed.status).toBe(200);
    expect(committed.headers.get('cache-control')).toBe('no-store');
    expect(await committed.json()).toEqual({ recordId, status: 'VERIFIED', revision: 2 });
    expect(personal.approve).toHaveBeenCalledWith(token, grantToken, recordId, commitBody);
  });

  it('approves root-secret fallback, agent bearer and cookies before service call', async () => {
    const routes = [
      base + '/operator/personal-approval-grants',
      base + '/' + recordId + '/personal-approve',
    ];
    for (const path of routes) {
      for (const headers of [
        { ...goodHeaders, authorization: 'Bearer ' + 'A'.repeat(43) },
        { ...goodHeaders, authorization: 'Bearer ' + root },
        { ...goodHeaders, 'x-dev-hub-memory-operator-secret': root },
        { ...goodHeaders, 'x-dev-hub-memory-approval-grant': 'A'.repeat(43) },
        { ...goodHeaders, cookie: 'session=fake' },
      ])
        expect([401, 403]).toContain((await post(path, reviewBody, headers)).status);
      expect((await post(path, reviewBody, { ...goodHeaders, authorization: '' })).status).toBe(
        401,
      );
    }
    expect(personal.reviewAndGrant).not.toHaveBeenCalled();
    expect(personal.approve).not.toHaveBeenCalled();
  });

  it('approves cross-site, foreign Origin, query token and invalid JSON content type', async () => {
    const path = base + '/operator/personal-approval-grants';
    for (const headers of [
      { ...goodHeaders, origin: 'http://evil.example' },
      { ...goodHeaders, 'sec-fetch-site': 'cross-site' },
      { ...goodHeaders, 'content-type': 'text/plain' },
    ])
      expect((await post(path, reviewBody, headers)).status).toBe(403);
    expect((await post(path + '?token=fake', reviewBody)).status).toBe(403);
    expect(personal.reviewAndGrant).not.toHaveBeenCalled();
  });
});
