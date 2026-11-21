import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';
import { MemoryOperatorCredentialService } from '../src/security/memory-operator-credential.service.js';
import { MemorySecurityError } from '../src/security/memory-security-policy.js';

const repo = 'sauron9521/gym-dev-hub';
const secret = 'operator-only-test-secret-at-least-32-characters';
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_SECRET: secret,
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repo,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
};
const scoped = () => ({
  kind: 'agent' as const,
  repository: repo,
  agentId: randomUUID(),
  taskId: randomUUID(),
  sessionId: randomUUID(),
  ttlSeconds: 60,
});
const services = (verify = vi.fn().mockResolvedValue(undefined)) => {
  const auth = new MemoryAuthorizationService(env);
  return { auth, verify, service: new MemoryOperatorCredentialService(auth, env, verify) };
};

describe('operator-only registered memory agent credential lifecycle', () => {
  it('authenticates operator before database access or parsing scope', async () => {
    const { service, verify } = services();
    await expect(service.issue('wrong operator secret', scoped())).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(service.issue(undefined, scoped())).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('provisions a one-time-returned read-only bearer only after repository membership preflight', async () => {
    const { service, auth, verify } = services();
    const input = scoped();
    const issued = await service.issue(secret, input);
    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.calls[0]?.[0]).toMatchObject({
      type: 'agent',
      repository: repo,
      permission: 'READ_VERIFIED',
      readContext: {
        repository: repo,
        agentId: input.agentId,
        taskId: input.taskId,
        sessionId: input.sessionId,
      },
    });
    expect(issued.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.permission).toBe('READ_VERIFIED');
    expect(auth.authenticateReadBearer(issued.bearerToken).readContext).toMatchObject({
      repository: repo,
      agentId: input.agentId,
      taskId: input.taskId,
      sessionId: input.sessionId,
    });
    expect(auth.auditSnapshot().at(-1)).toMatchObject({ event: 'credential-issued' });
    expect(JSON.stringify(auth.auditSnapshot())).not.toContain(issued.bearerToken);
    expect(JSON.stringify(auth.auditSnapshot())).not.toContain(secret);
  });

  it.each([
    [{ ...scoped(), kind: 'external' }],
    [{ ...scoped(), repository: 'sauron9521/gym-platform' }],
    [{ ...scoped(), agentId: undefined }],
    [{ ...scoped(), ttlSeconds: 901 }],
    [{ ...scoped(), ttlSeconds: 0 }],
    [{ ...scoped(), extra: 'not allowed' }],
    [{ ...scoped(), taskId: undefined }],
    [{ ...scoped(), sessionId: undefined }],
  ])('rejects unsupported/unscoped credential bodies before database use', async (input) => {
    const { service, verify } = services();
    await expect(service.issue(secret, input)).rejects.toMatchObject({ code: 'forbidden' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses foreign/unlinked identity, database outage and missing DB config without issuing a token', async () => {
    const denied = services(vi.fn().mockRejectedValue(new MemorySecurityError('forbidden')));
    await expect(denied.service.issue(secret, scoped())).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(denied.auth.auditSnapshot()).toHaveLength(0);

    const failed = services(vi.fn().mockRejectedValue(new Error('private db password')));
    await expect(failed.service.issue(secret, scoped())).rejects.toMatchObject({
      code: 'disabled',
      message: 'Memory security disabled',
    });
    expect(failed.auth.auditSnapshot()).toHaveLength(0);

    const noConfigAuth = new MemoryAuthorizationService(env);
    const noConfig = new MemoryOperatorCredentialService(noConfigAuth, env);
    await expect(noConfig.issue(secret, scoped())).rejects.toMatchObject({ code: 'disabled' });
    expect(noConfigAuth.auditSnapshot()).toHaveLength(0);
  });

  it('revokes by credential ID, forbids wrong secret and invalid IDs', async () => {
    const { service, auth } = services();
    const issued = await service.issue(secret, scoped());
    expect(() => service.revoke('wrong', issued.credentialId)).toThrowError(MemorySecurityError);
    expect(auth.authenticateReadBearer(issued.bearerToken).permission).toBe('READ_VERIFIED');
    expect(service.revoke(secret, issued.credentialId)).toEqual({ revoked: true });
    expect(() => auth.authenticateReadBearer(issued.bearerToken)).toThrowError(MemorySecurityError);
    expect(service.revoke(secret, issued.credentialId)).toEqual({ revoked: false });
    expect(() => service.revoke(secret, '../wrong')).toThrowError(MemorySecurityError);
  });

  it('requires loopback socket, exact trusted origin and refuses tokens in URL', () => {
    const { service } = services();
    const base = {
      method: 'POST',
      host: '127.0.0.1:3101',
      remoteAddress: '127.0.0.1',
      origin: env.DEV_HUB_MEMORY_TRUSTED_ORIGIN,
      fetchSite: undefined,
      path: '/v1/memory/operator/credentials',
    };
    expect(() => service.assertLocalOperatorHttp(base)).not.toThrow();
    for (const req of [
      { ...base, remoteAddress: '10.0.0.3' },
      { ...base, origin: 'https://attacker.example' },
      { ...base, origin: undefined },
      { ...base, host: 'evil.example:3101' },
      { ...base, fetchSite: 'cross-site' },
      { ...base, path: base.path + '?access_token=exposed' },
    ]) {
      expect(() => service.assertLocalOperatorHttp(req)).toThrowError(MemorySecurityError);
    }
  });

  it('refuses credential requests while memory security is not explicitly enabled', async () => {
    const disabledEnv = { ...env, DEV_HUB_MEMORY_SECURITY_ENABLE: 'false' };
    const verify = vi.fn();
    const service = new MemoryOperatorCredentialService(
      new MemoryAuthorizationService(disabledEnv),
      disabledEnv,
      verify,
    );
    await expect(service.issue(secret, scoped())).rejects.toMatchObject({ code: 'disabled' });
    expect(verify).not.toHaveBeenCalled();
  });
});
