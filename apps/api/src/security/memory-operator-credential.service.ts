import pg from 'pg';
import { z } from 'zod';
import { MemoryRepositorySchema } from '@gym-dev-hub/contracts';
import { resolveMemoryDatabaseConfiguration } from '../database/memory-database-policy.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryPrincipal } from './memory-authorization.service.js';
import { verifyMemoryPrincipalBinding } from './memory-principal-binding.js';
import {
  assertMemoryLocalBoundary,
  MemorySecurityError,
  memorySecurityConfig,
} from './memory-security-policy.js';
import type { LocalMemoryHttpRequest } from './memory-security-policy.js';

const agentCredentialSchema = z.strictObject({
  kind: z.literal('agent'),
  repository: MemoryRepositorySchema,
  agentId: z.uuid(),
  taskId: z.uuid(),
  sessionId: z.uuid(),
  ttlSeconds: z.number().int().min(1).max(900),
});

type ScopeVerifier = (principal: MemoryPrincipal) => Promise<void>;

/**
 * Opt-in operator-only credentials for registered Hub memory agents.
 * Never issues external MCP credentials, approval grants or DB writes;
 * agent read routes are independently guarded and explicitly opt-in.
 * The shared authorization instance lives in MemoryModule until restart.
 */
export class MemoryOperatorCredentialService {
  constructor(
    readonly authorization: MemoryAuthorizationService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly verifyScope: ScopeVerifier = async (principal) => {
      const config = resolveMemoryDatabaseConfiguration(this.env);
      if (!config.enabled) throw new MemorySecurityError('disabled');
      // Never use the Gym Platform DB, remote PostgreSQL or a non-dedicated user.
      const pool = new pg.Pool({
        connectionString: config.url,
        ssl: false,
        max: 1,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 1000,
      });
      try {
        await verifyMemoryPrincipalBinding(principal, pool);
      } finally {
        await pool.end();
      }
    },
  ) {}

  assertLocalOperatorHttp(request: LocalMemoryHttpRequest): void {
    assertMemoryLocalBoundary(request, memorySecurityConfig(this.env).trustedOrigin);
  }

  async issue(
    operatorSecret: unknown,
    input: unknown,
  ): Promise<{
    credentialId: string;
    bearerToken: string;
    expiresAt: string;
    permission: 'READ_VERIFIED';
  }> {
    // Authenticate the operator BEFORE parsing untrusted input or opening the DB.
    this.authorization.assertOperatorForCredentialRequest(operatorSecret);
    if (typeof operatorSecret !== 'string') throw new MemorySecurityError('unauthorized');
    const parsed = agentCredentialSchema.safeParse(input);
    if (!parsed.success) throw new MemorySecurityError('forbidden');
    const scope = parsed.data;
    const config = memorySecurityConfig(this.env);
    if (!config.repositories.includes(scope.repository)) throw new MemorySecurityError('forbidden');

    const principal: MemoryPrincipal = {
      type: 'agent',
      actorId: 'operator-credential-preflight',
      repository: scope.repository,
      permission: 'READ_VERIFIED',
      readContext: {
        repository: scope.repository,
        agentId: scope.agentId,
        ...(scope.taskId ? { taskId: scope.taskId } : {}),
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      },
    };
    try {
      // Do not mint a token for foreign/unregistered or unrelated identities.
      await this.verifyScope(principal);
    } catch (error) {
      if (error instanceof MemorySecurityError) throw error;
      // No database connection string, query or raw error appears in the response.
      throw new MemorySecurityError('disabled');
    }
    return this.authorization.provisionReadCredential(operatorSecret, scope);
  }

  revoke(operatorSecret: unknown, credentialId: string): { revoked: boolean } {
    this.authorization.assertOperatorForCredentialRequest(operatorSecret);
    if (typeof operatorSecret !== 'string') throw new MemorySecurityError('unauthorized');
    return { revoked: this.authorization.revokeCredential(operatorSecret, credentialId) };
  }
}
