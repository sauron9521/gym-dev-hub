import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';
import {
  authenticateMemoryHttpRead,
  toMemoryHttpException,
} from '../src/security/memory-http-identity.js';
import { MemorySecurityError } from '../src/security/memory-security-policy.js';

const secret = 'some-local-operator-secret-of-sufficient-length';
const repo = 'sauron9521/gym-dev-hub';
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_SECRET: secret,
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repo,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
};
const request = (authorization?: string) => ({
  method: 'GET',
  host: '127.0.0.1:3101',
  remoteAddress: '127.0.0.1',
  origin: 'http://127.0.0.1:3100',
  fetchSite: 'same-origin',
  path: '/v1/memory?repository=' + repo,
  authorization,
});

describe('reserved memory HTTP auth mapping (no registered routes)', () => {
  it('rejects anonymous, cookie-style, malformed or query-only tokens with 401', () => {
    const svc = new MemoryAuthorizationService(env);
    for (const header of [
      undefined,
      'Basic password',
      'Bearer',
      'bearer test',
      'Bearer invalid',
      'Bearer ' + 'A'.repeat(43) + ' extra',
    ]) {
      try {
        authenticateMemoryHttpRead(request(header), svc, env);
        throw Error('Unprotected');
      } catch (e) {
        expect((e as { getStatus: () => number }).getStatus()).toBe(401);
      }
    }
  });
  it('valid bearer supplies only memory-scoped READ_VERIFIED principal; spoofed URL repo does not broaden it', () => {
    const svc = new MemoryAuthorizationService(env);
    const agentId = randomUUID();
    const bearer = svc.provisionReadCredential(secret, {
      kind: 'agent',
      repository: repo,
      agentId,
      ttlSeconds: 30,
    }).bearerToken;
    const authenticated = authenticateMemoryHttpRead(request('Bearer ' + bearer), svc, env);
    expect(authenticated).toMatchObject({
      type: 'agent',
      permission: 'READ_VERIFIED',
      repository: repo,
      readContext: { repository: repo, agentId },
    });
    const wrongRepoRequest = {
      ...request('Bearer ' + bearer),
      path: '/v1/memory?repository=sauron9521/gym-platform',
    };
    const spoofed = authenticateMemoryHttpRead(wrongRepoRequest, svc, env);
    expect(spoofed.repository).toBe(repo); // query string NEVER creates principal
  });
  it('remote request, origin mismatch or token in URL rejected with 403', () => {
    const svc = new MemoryAuthorizationService(env);
    const bearer = svc.provisionReadCredential(secret, {
      kind: 'agent',
      repository: repo,
      agentId: randomUUID(),
      ttlSeconds: 30,
    }).bearerToken;
    for (const req of [
      { ...request('Bearer ' + bearer), remoteAddress: '10.0.0.2' },
      { ...request('Bearer ' + bearer), origin: 'https://attacker.example' },
      { ...request('Bearer ' + bearer), path: '/v1/memory?token=' + bearer },
    ]) {
      try {
        authenticateMemoryHttpRead(req, svc, env);
        throw Error('Unprotected');
      } catch (e) {
        expect((e as { getStatus: () => number }).getStatus()).toBe(403);
      }
    }
  });
  it('maps missing config to 503 and policy exceptions to safe 401/403/429', () => {
    const svc = new MemoryAuthorizationService(env);
    try {
      authenticateMemoryHttpRead(request(), svc, {
        ...env,
        DEV_HUB_MEMORY_SECURITY_ENABLE: 'false',
      });
      throw Error('Unprotected');
    } catch (e) {
      expect((e as { getStatus: () => number }).getStatus()).toBe(503);
    }
    expect(toMemoryHttpException(new MemorySecurityError('unauthorized')).getStatus()).toBe(401);
    expect(toMemoryHttpException(new MemorySecurityError('forbidden')).getStatus()).toBe(403);
    expect(toMemoryHttpException(new MemorySecurityError('rate-limited')).getStatus()).toBe(429);
    expect(toMemoryHttpException(new Error('database secret leaked?')).message).not.toContain(
      'database secret leaked?',
    );
  });
});
