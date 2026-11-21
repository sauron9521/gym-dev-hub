import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';
import {
  authenticateMemoryHttpProposal,
  authenticateMemoryHttpRead,
} from '../src/security/memory-http-identity.js';

const secret = 'independent-local-operator-secret-32bytes-long';
const repository = 'sauron9521/gym-dev-hub';
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_SECRET: secret,
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repository,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
  DEV_HUB_MEMORY_EXTERNAL_READ_ENABLE: 'true',
};
const scope = () => ({
  kind: 'agent' as const,
  repository,
  agentId: randomUUID(),
  taskId: randomUUID(),
  sessionId: randomUUID(),
  ttlSeconds: 60,
});
const request = (bearerToken: string) => ({
  method: 'POST',
  host: '127.0.0.1:3101',
  remoteAddress: '127.0.0.1',
  origin: 'http://127.0.0.1:3100',
  fetchSite: 'same-origin',
  path: '/v1/memory/proposals',
  authorization: 'Bearer ' + bearerToken,
});

describe('separate memory proposal capability', () => {
  it('read-only credentials cannot submit a proposal; proposal-only cannot read or approve', () => {
    const svc = new MemoryAuthorizationService(env);
    const read = svc.provisionReadCredential(secret, scope());
    const proposal = svc.provisionReadCredential(secret, {
      ...scope(),
      permission: 'PROPOSE_MEMORY',
    });
    expect(read.permission).toBe('READ_VERIFIED');
    expect(proposal.permission).toBe('PROPOSE_MEMORY');
    expect(() => svc.authenticateProposalBearer(read.bearerToken)).toThrowError(/forbidden/);
    expect(() => authenticateMemoryHttpProposal(request(read.bearerToken), svc, env)).toThrowError(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => svc.authenticateReadBearer(proposal.bearerToken)).toThrowError(/forbidden/);
    expect(() =>
      authenticateMemoryHttpRead(
        {
          ...request(proposal.bearerToken),
          method: 'GET',
        },
        svc,
        env,
      ),
    ).toThrowError(expect.objectContaining({ status: 403 }));
    expect(svc.authenticateProposalBearer(proposal.bearerToken)).toMatchObject({
      type: 'agent',
      permission: 'PROPOSE_MEMORY',
      repository,
    });
    expect(() => svc.issueOperatorApprovalGrant(proposal.bearerToken, {})).toThrow();
    svc.revokeCredential(secret, proposal.credentialId);
    expect(() => svc.authenticateProposalBearer(proposal.bearerToken)).toThrow();
  });

  it('requires explicit proposal flag and invalidates prior tokens when the flag changes', () => {
    const disabled = { ...env, DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE: 'false' };
    const svc = new MemoryAuthorizationService(disabled);
    expect(() =>
      svc.provisionReadCredential(secret, {
        ...scope(),
        permission: 'PROPOSE_MEMORY',
      }),
    ).toThrowError(/disabled/);
    const read = svc.provisionReadCredential(secret, scope());
    expect(svc.authenticateReadBearer(read.bearerToken).permission).toBe('READ_VERIFIED');
    disabled.DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE = 'true';
    expect(() => svc.authenticateReadBearer(read.bearerToken)).toThrowError(/unauthorized/);
    const proposed = svc.provisionReadCredential(secret, {
      ...scope(),
      permission: 'PROPOSE_MEMORY',
    });
    disabled.DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE = 'false';
    expect(() => svc.authenticateProposalBearer(proposed.bearerToken)).toThrowError(/unauthorized/);
    expect(() =>
      new MemoryAuthorizationService({
        ...env,
        DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE: 'yes',
      }).provisionReadCredential(secret, scope()),
    ).toThrowError(/disabled/);
  });

  it('never allows external/MCP or partial agent credentials to gain propose permission', () => {
    const svc = new MemoryAuthorizationService(env);
    expect(() =>
      svc.provisionReadCredential(secret, {
        kind: 'external',
        repository,
        ttlSeconds: 60,
        permission: 'PROPOSE_MEMORY',
      }),
    ).toThrowError(/forbidden/);
    const partial = { ...scope(), taskId: undefined };
    expect(() =>
      svc.provisionReadCredential(secret, {
        ...partial,
        permission: 'PROPOSE_MEMORY',
      }),
    ).toThrowError(/forbidden/);
    expect(svc.auditSnapshot()).toHaveLength(0);
  });

  it('rejects cross-site, missing Origin, remote peer and query bearer before proposal auth', () => {
    const svc = new MemoryAuthorizationService(env);
    const bearer = svc.provisionReadCredential(secret, {
      ...scope(),
      permission: 'PROPOSE_MEMORY',
    }).bearerToken;
    for (const bad of [
      { origin: 'http://evil.example' },
      { origin: undefined },
      { remoteAddress: '192.168.0.1' },
      { host: 'evil.example:3101' },
      { fetchSite: 'cross-site' },
      { path: '/v1/memory/proposals?token=stolen' },
    ]) {
      expect(() =>
        authenticateMemoryHttpProposal(
          {
            ...request(bearer),
            ...bad,
          },
          svc,
          env,
        ),
      ).toThrowError(expect.objectContaining({ status: 403 }));
    }
    expect(svc.authenticateProposalBearer(bearer).permission).toBe('PROPOSE_MEMORY');
  });
});
