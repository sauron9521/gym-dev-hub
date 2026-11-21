import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryPrincipal } from './memory-authorization.service.js';
import type pg from 'pg';
import { verifyMemoryPrincipalBinding } from './memory-principal-binding.js';
import {
  assertMemoryLocalBoundary,
  MemorySecurityError,
  memorySecurityConfig,
} from './memory-security-policy.js';
import type { LocalMemoryHttpRequest } from './memory-security-policy.js';

/** Local verified memory HTTP read request; never accepts cookie or query credentials. */
export type MemoryHttpReadRequest = LocalMemoryHttpRequest & {
  authorization: string | undefined;
};

export function toMemoryHttpException(error: unknown): HttpException {
  if (!(error instanceof MemorySecurityError))
    return new ServiceUnavailableException('Memory authorization unavailable');
  switch (error.code) {
    case 'unauthorized':
      return new UnauthorizedException('Memory credentials required');
    case 'forbidden':
      return new ForbiddenException('Memory operation not permitted');
    case 'rate-limited':
      return new HttpException('Memory authorization rate limited', HttpStatus.TOO_MANY_REQUESTS);
    case 'disabled':
      return new ServiceUnavailableException('Memory access disabled');
  }
}

/**
 * Strict Authorization: Bearer <token>; no cookies or URL credentials.
 * Agent-only local HTTP routes use this helper; PostgreSQL membership must
 * still be checked after successful authentication on every request.
 */
export function authenticateMemoryHttpRead(
  request: MemoryHttpReadRequest,
  authorization: MemoryAuthorizationService,
  env: NodeJS.ProcessEnv,
): MemoryPrincipal {
  try {
    const config = memorySecurityConfig(env);
    assertMemoryLocalBoundary(request, config.trustedOrigin);
    const header = request.authorization;
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) {
      throw new MemorySecurityError('unauthorized');
    }
    const principal = authorization.authenticateReadBearer(header.slice('Bearer '.length));
    // External/MCP bearers have a separate opt-in and must not be usable on
    // local agent HTTP routes. Reject legacy unbound agent tokens as well.
    if (
      principal.type !== 'agent' ||
      !principal.readContext.agentId ||
      !principal.readContext.taskId ||
      !principal.readContext.sessionId
    )
      throw new MemorySecurityError('forbidden');
    return principal;
  } catch (error) {
    throw toMemoryHttpException(error);
  }
}

/**
 * Authenticate local Bearer first, then verify the exact bearer-derived
 * repository/task/session/agent binding in PostgreSQL.
 * No request parameters are allowed to supply scope.
 */
export async function authenticateMemoryHttpReadWithDatabase(
  request: MemoryHttpReadRequest,
  authorization: MemoryAuthorizationService,
  env: NodeJS.ProcessEnv,
  db: Pick<pg.Pool, 'query'>,
): Promise<MemoryPrincipal> {
  const principal = authenticateMemoryHttpRead(request, authorization, env);
  try {
    return await verifyMemoryPrincipalBinding(principal, db);
  } catch (error) {
    throw toMemoryHttpException(error);
  }
}
/**
 * Never re-purpose READ_VERIFIED as a write capability. Only a separately
 * operator-issued session-bound PROPOSE_MEMORY Bearer may enter proposal intake.
 */
export function authenticateMemoryHttpProposal(
  request: MemoryHttpReadRequest,
  authorization: MemoryAuthorizationService,
  env: NodeJS.ProcessEnv,
): MemoryPrincipal {
  try {
    const config = memorySecurityConfig(env);
    assertMemoryLocalBoundary(request, config.trustedOrigin);
    const header = request.authorization;
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
      throw new MemorySecurityError('unauthorized');
    return authorization.authenticateProposalBearer(header.slice('Bearer '.length));
  } catch (error) {
    throw toMemoryHttpException(error);
  }
}
