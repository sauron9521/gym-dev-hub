import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertMemoryLocalBoundary,
  MemorySecurityError,
  memorySecurityConfig,
} from '../src/security/memory-security-policy.js';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';

const operatorSecret = 'private-memory-operator-secret-'.repeat(2);
const repoA = 'sauron9521/gym-dev-hub';
const repoB = 'sauron9521/gym-platform';
const agentId = randomUUID();
const taskId = randomUUID();
const sessionId = randomUUID();
const recordId = randomUUID();
const fingerprint = 'sha256:' + createHash('sha256').update('reviewed-by-operator').digest('hex');
const intent = {
  repository: repoA,
  action: 'APPROVE_MEMORY_PROPOSAL',
  recordId,
  expectedRevision: 3,
  fingerprint,
};
const environment = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_SECRET: operatorSecret,
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: `${repoA},${repoB}`,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
  ...extra,
});

describe('memory security independent configuration and loopback boundary', () => {
  it('is disabled by default, if DB disabled or operator secret missing', () => {
    for (const env of [
      {},
      environment({ DEV_HUB_MEMORY_ENABLE: 'false' }),
      environment({ DEV_HUB_MEMORY_OPERATOR_SECRET: 'short' }),
      environment({ DEV_HUB_MEMORY_SECURITY_ENABLE: 'false' }),
    ]) {
      expect(() => memorySecurityConfig(env)).toThrow(MemorySecurityError);
    }
  });
  it('requires dedicated secret not shared with worktree or tool grants', () => {
    expect(() =>
      memorySecurityConfig(environment({ DEV_HUB_WORKTREE_OPERATOR_SECRET: operatorSecret })),
    ).toThrow();
    expect(() =>
      memorySecurityConfig(environment({ DEV_HUB_TASK_GRANT_OPERATOR_SECRET: operatorSecret })),
    ).toThrow();
    expect(() =>
      memorySecurityConfig(environment({ DEV_HUB_WORKER_TOOL_SECRET: operatorSecret })),
    ).toThrow();
  });
  it('rejects empty, duplicate, wildcard, malformed or implicit repository grants', () => {
    for (const allowed of ['', `${repoA},${repoA}`, '*', 'repo', `${repoA},../parent`]) {
      expect(() =>
        memorySecurityConfig(environment({ DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: allowed })),
      ).toThrow();
    }
  });
  it('requires exact local http trusted origin and separate external opt-in', () => {
    for (const origin of [
      'https://site.example',
      'http://0.0.0.0:3100',
      'http://127.0.0.1',
      'http://127.0.0.1:3100/path',
      'http://user@127.0.0.1:3100',
    ]) {
      expect(() =>
        memorySecurityConfig(environment({ DEV_HUB_MEMORY_TRUSTED_ORIGIN: origin })),
      ).toThrow();
    }
    expect(memorySecurityConfig(environment()).externalReadEnabled).toBe(false);
    expect(
      memorySecurityConfig(environment({ DEV_HUB_MEMORY_EXTERNAL_READ_ENABLE: 'true' }))
        .externalReadEnabled,
    ).toBe(true);
    expect(() =>
      memorySecurityConfig(environment({ DEV_HUB_MEMORY_EXTERNAL_READ_ENABLE: 'yes' })),
    ).toThrow();
  });
  it('accepts precise local Web origin and loopback request', () => {
    expect(() =>
      assertMemoryLocalBoundary(
        {
          method: 'POST',
          host: '127.0.0.1:3101',
          remoteAddress: '::ffff:127.0.0.1',
          origin: 'http://127.0.0.1:3100',
          fetchSite: 'same-origin',
          path: '/v1/memory/proposals',
        },
        'http://127.0.0.1:3100',
      ),
    ).not.toThrow();
  });
  it.each([
    {
      method: 'POST',
      host: '127.0.0.1:3101',
      remoteAddress: '10.1.1.1',
      origin: 'http://127.0.0.1:3100',
      fetchSite: 'same-origin',
      path: '/v1/memory',
    },
    {
      method: 'POST',
      host: '0.0.0.0:3101',
      remoteAddress: '127.0.0.1',
      origin: 'http://127.0.0.1:3100',
      fetchSite: 'same-origin',
      path: '/v1/memory',
    },
    {
      method: 'POST',
      host: 'evil.example:3101',
      remoteAddress: '127.0.0.1',
      origin: 'http://127.0.0.1:3100',
      fetchSite: 'same-origin',
      path: '/v1/memory',
    },
    {
      method: 'POST',
      host: '127.0.0.1:3101',
      remoteAddress: '127.0.0.1',
      origin: 'https://evil.example',
      fetchSite: 'cross-site',
      path: '/v1/memory',
    },
    {
      method: 'POST',
      host: '127.0.0.1:3101',
      remoteAddress: '127.0.0.1',
      origin: undefined,
      fetchSite: 'none',
      path: '/v1/memory',
    },
    {
      method: 'GET',
      host: '127.0.0.1:3101',
      remoteAddress: '127.0.0.1',
      origin: undefined,
      fetchSite: 'cross-site',
      path: '/v1/memory',
    },
    {
      method: 'GET',
      host: '127.0.0.1:3101',
      remoteAddress: '127.0.0.1',
      origin: undefined,
      fetchSite: 'none',
      path: '/v1/memory?access_token=sensitive',
    },
  ])('rejects remote host, spoofed origin, missing mutation origin or URL token', (request) => {
    expect(() => assertMemoryLocalBoundary(request, 'http://127.0.0.1:3100')).toThrow(
      MemorySecurityError,
    );
  });
});

describe('ephemeral memory principals and read-only agent credentials', () => {
  it('refuses token minting without operator authentication', () => {
    const svc = new MemoryAuthorizationService(environment());
    const payload = { kind: 'agent', repository: repoA, agentId, taskId, ttlSeconds: 60 };
    expect(() => svc.provisionReadCredential('wrong-secret', payload)).toThrowError(/unauthorized/);
    expect(() => svc.provisionReadCredential('', payload)).toThrowError(/unauthorized/);
    expect(svc.auditSnapshot()).toEqual([]);
  });
  it('mints a hashed, repo/task/session-scoped READ credential only on explicit operator approval', () => {
    const svc = new MemoryAuthorizationService(environment());
    const created = svc.provisionReadCredential(operatorSecret, {
      kind: 'agent',
      repository: repoA,
      agentId,
      taskId,
      sessionId,
      ttlSeconds: 120,
    });
    expect(created.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const principal = svc.authenticateReadBearer(created.bearerToken);
    expect(principal).toMatchObject({
      type: 'agent',
      repository: repoA,
      permission: 'READ_VERIFIED',
      readContext: { repository: repoA, agentId, taskId, sessionId },
    });
    expect(Object.keys(principal)).not.toContain('operatorSecret');
    expect(JSON.stringify(svc.auditSnapshot())).not.toContain(created.bearerToken);
    expect(JSON.stringify(svc.auditSnapshot())).not.toContain(operatorSecret);
    expect(JSON.stringify(principal)).not.toMatch(/shell|git|merge|docker|APPROVE_MEMORY_PROPOSAL/);
  });
  it('never allows provisioning for unlisted repo, unbound session or foreign principal', () => {
    const svc = new MemoryAuthorizationService(
      environment({ DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repoA }),
    );
    for (const payload of [
      { kind: 'agent', repository: repoB, agentId, taskId, ttlSeconds: 60 },
      { kind: 'agent', repository: repoA, taskId, ttlSeconds: 60 },
      { kind: 'agent', repository: repoA, agentId, sessionId, ttlSeconds: 60 },
      { kind: 'operator', repository: repoA, agentId, ttlSeconds: 60 },
    ])
      expect(() => svc.provisionReadCredential(operatorSecret, payload)).toThrow(
        MemorySecurityError,
      );
  });
  it('denies external identities by default, and only issues max-5-minute read token when separately enabled', () => {
    const svc = new MemoryAuthorizationService(environment());
    expect(() =>
      svc.provisionReadCredential(operatorSecret, {
        kind: 'external',
        repository: repoA,
        ttlSeconds: 180,
      }),
    ).toThrow();
    const permitted = new MemoryAuthorizationService(
      environment({ DEV_HUB_MEMORY_EXTERNAL_READ_ENABLE: 'true' }),
    );
    expect(() =>
      permitted.provisionReadCredential(operatorSecret, {
        kind: 'external',
        repository: repoA,
        ttlSeconds: 301,
      }),
    ).toThrow();
    const x = permitted.provisionReadCredential(operatorSecret, {
      kind: 'external',
      repository: repoA,
      taskId,
      ttlSeconds: 180,
    });
    expect(permitted.authenticateReadBearer(x.bearerToken)).toMatchObject({
      type: 'external',
      permission: 'READ_VERIFIED',
      readContext: { repository: repoA, taskId },
    });
    expect(() => permitted.issueOperatorApprovalGrant(x.bearerToken, intent)).toThrow(
      MemorySecurityError,
    );
  });
  it('revokes credentials, expires tokens and never accepts another process instance bearer', () => {
    let now = 1_800_000_000_000;
    const env = environment();
    const svc = new MemoryAuthorizationService(env, () => now);
    const x = svc.provisionReadCredential(operatorSecret, {
      kind: 'agent',
      repository: repoA,
      agentId,
      ttlSeconds: 1,
    });
    expect(() =>
      new MemoryAuthorizationService(env, () => now).authenticateReadBearer(x.bearerToken),
    ).toThrow();
    expect(svc.revokeCredential(operatorSecret, x.credentialId)).toBe(true);
    expect(() => svc.authenticateReadBearer(x.bearerToken)).toThrow();
    const y = svc.provisionReadCredential(operatorSecret, {
      kind: 'agent',
      repository: repoA,
      agentId,
      ttlSeconds: 1,
    });
    now += 1000;
    expect(() => svc.authenticateReadBearer(y.bearerToken)).toThrow();
  });
  it('rotation, changed allowlist and feature disable immediately revoke previously issued tokens', () => {
    const env = environment();
    const svc = new MemoryAuthorizationService(env);
    const x = svc.provisionReadCredential(operatorSecret, {
      kind: 'agent',
      repository: repoA,
      agentId,
      ttlSeconds: 120,
    });
    env.DEV_HUB_MEMORY_OPERATOR_SECRET = 'rotated-operator-secret-'.repeat(2);
    expect(() => svc.authenticateReadBearer(x.bearerToken)).toThrow();
    const next = svc.provisionReadCredential(env.DEV_HUB_MEMORY_OPERATOR_SECRET, {
      kind: 'agent',
      repository: repoA,
      agentId,
      ttlSeconds: 120,
    });
    env.DEV_HUB_MEMORY_ALLOWED_REPOSITORIES = repoB;
    expect(() => svc.authenticateReadBearer(next.bearerToken)).toThrow();
    env.DEV_HUB_MEMORY_SECURITY_ENABLE = 'false';
    expect(() => svc.authenticateReadBearer(next.bearerToken)).toThrow();
  });
  it('operator authentication rate limits repeated guesses; messages cannot echo guesses', () => {
    let now = 1_800_000_000_000;
    const svc = new MemoryAuthorizationService(environment(), () => now);
    let text = '';
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        svc.provisionReadCredential('a guessed credential never saved', {
          kind: 'agent',
          repository: repoA,
          agentId,
          ttlSeconds: 60,
        });
      } catch (e) {
        text = String(e);
      }
    }
    expect(text).not.toContain('a guessed credential');
    expect(() =>
      svc.provisionReadCredential(operatorSecret, {
        kind: 'agent',
        repository: repoA,
        agentId,
        ttlSeconds: 60,
      }),
    ).toThrowError(/rate-limited/);
    now += 60_000;
    expect(
      svc.provisionReadCredential(operatorSecret, {
        kind: 'agent',
        repository: repoA,
        agentId,
        ttlSeconds: 60,
      }).permission,
    ).toBe('READ_VERIFIED');
  });
});

describe('operator-only, one-use memory approval grants (no writes)', () => {
  it('accepts a single exact action/repo/record/revision/fingerprint and denies replay', () => {
    const svc = new MemoryAuthorizationService(environment());
    const grant = svc.issueOperatorApprovalGrant(operatorSecret, intent);
    expect(grant.action).toBe('APPROVE_MEMORY_PROPOSAL');
    expect(svc.consumeOperatorApprovalGrant(operatorSecret, grant.grantToken, intent)).toBe(true);
    expect(() =>
      svc.consumeOperatorApprovalGrant(operatorSecret, grant.grantToken, intent),
    ).toThrowError(/forbidden/);
    const audit = JSON.stringify(svc.auditSnapshot());
    expect(audit).not.toContain(grant.grantToken);
    expect(audit).not.toContain(operatorSecret);
  });
  it('consumes token on wrong action, repository, revision or content fingerprint', () => {
    for (const changes of [
      { action: 'REVOKE_MEMORY_RECORD' },
      { repository: repoB },
      { expectedRevision: 4 },
      { recordId: randomUUID() },
      { fingerprint: 'sha256:' + 'f'.repeat(64) },
    ]) {
      const svc = new MemoryAuthorizationService(environment());
      const grant = svc.issueOperatorApprovalGrant(operatorSecret, intent);
      expect(() =>
        svc.consumeOperatorApprovalGrant(operatorSecret, grant.grantToken, {
          ...intent,
          ...changes,
        }),
      ).toThrowError(/forbidden/);
      expect(() =>
        svc.consumeOperatorApprovalGrant(operatorSecret, grant.grantToken, intent),
      ).toThrowError(/forbidden/);
    }
  });
  it('grant revocation, expiry, secret rotation and separate process reject reuse', () => {
    let now = 1_800_000_000_000;
    const env = environment();
    const svc = new MemoryAuthorizationService(env, () => now);
    const r = svc.issueOperatorApprovalGrant(operatorSecret, intent);
    expect(() =>
      new MemoryAuthorizationService(env, () => now).consumeOperatorApprovalGrant(
        operatorSecret,
        r.grantToken,
        intent,
      ),
    ).toThrow();
    expect(svc.revokeOperatorGrant(operatorSecret, r.grantId)).toBe(true);
    expect(() => svc.consumeOperatorApprovalGrant(operatorSecret, r.grantToken, intent)).toThrow();
    const next = svc.issueOperatorApprovalGrant(operatorSecret, intent);
    now += 45_000;
    expect(() =>
      svc.consumeOperatorApprovalGrant(operatorSecret, next.grantToken, intent),
    ).toThrow();
    const last = svc.issueOperatorApprovalGrant(operatorSecret, intent);
    env.DEV_HUB_MEMORY_OPERATOR_SECRET = 'another-operator-secret-'.repeat(2);
    expect(() =>
      svc.consumeOperatorApprovalGrant(env.DEV_HUB_MEMORY_OPERATOR_SECRET, last.grantToken, intent),
    ).toThrow();
  });
  it('never grants arbitrary shell, Git, merge or cross-repo mutation authority', () => {
    const svc = new MemoryAuthorizationService(
      environment({ DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repoA }),
    );
    for (const action of ['SHELL', 'GIT_PUSH', 'MERGE_PR', 'DOCKER_CHECK', 'MEMORY_APPROVE_ANY']) {
      expect(() => svc.issueOperatorApprovalGrant(operatorSecret, { ...intent, action })).toThrow(
        MemorySecurityError,
      );
    }
    expect(() =>
      svc.issueOperatorApprovalGrant(operatorSecret, { ...intent, repository: repoB }),
    ).toThrow(MemorySecurityError);
  });
});
