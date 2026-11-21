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

/** Only for future authenticated HTTP route wiring; not mounted by Issue #39. */
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
 * This helper must not be called by public routes until authenticated
 * repository registration + trusted principal wiring are reviewed in #39.
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
    return authorization.authenticateReadBearer(header.slice('Bearer '.length));
  } catch (error) {
    throw toMemoryHttpException(error);
  }
}

/**
 * Future HTTP route entrypoint: authenticate local Bearer first, then verify
 * every bearer-derived repository/task/session/agent binding in PostgreSQL.
 * Not mounted by this PR. No request parameters are allowed to supply scope.
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
