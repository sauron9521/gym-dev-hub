import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { MemoryRepositorySchema, MemoryReadContextSchema } from '@gym-dev-hub/contracts';
import type { MemoryReadContext } from '@gym-dev-hub/contracts';
import { MemorySecurityError, memorySecurityConfig } from './memory-security-policy.js';
import type { MemorySecurityConfiguration } from './memory-security-policy.js';

const uuid = z.uuid();
const credentialInputSchema = z.strictObject({
  kind: z.enum(['agent', 'external']),
  repository: MemoryRepositorySchema,
  agentId: uuid.optional(),
  taskId: uuid.optional(),
  sessionId: uuid.optional(),
  ttlSeconds: z.number().int().min(1).max(900),
  permission: z.enum(['READ_VERIFIED', 'PROPOSE_MEMORY']).optional(),
});
const grantInputSchema = z.strictObject({
  repository: MemoryRepositorySchema,
  action: z.enum(['APPROVE_MEMORY_PROPOSAL', 'REVOKE_MEMORY_RECORD']),
  recordId: uuid,
  expectedRevision: z.number().int().positive(),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type MemoryGrantIntent = z.infer<typeof grantInputSchema>;
export type MemoryPrincipal = Readonly<{
  type: 'agent' | 'external';
  actorId: string;
  repository: string;
  permission: 'READ_VERIFIED' | 'PROPOSE_MEMORY';
  readContext: MemoryReadContext;
}>;
export type MemorySecurityAuditEvent = Readonly<{
  event:
    | 'credential-issued'
    | 'credential-revoked'
    | 'grant-issued'
    | 'grant-revoked'
    | 'grant-consumed'
    | 'grant-denied';
  actorId: string;
  repository: string;
  resourceId: string;
  at: string;
}>;

type Credential = {
  id: string;
  type: 'agent' | 'external';
  repository: string;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  permission: 'READ_VERIFIED' | 'PROPOSE_MEMORY';
  expiresAt: number;
};
type Grant = MemoryGrantIntent & { id: string; expiresAt: number };
const MAX_CREDENTIALS = 64;
const MAX_GRANTS = 64;
const GRANT_TTL_MS = 45_000;
const MAX_AUDIT = 256;
const OPERATOR_ATTEMPTS_PER_MINUTE = 12;
const hash = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
const key = (value: string): string => hash(value).toString('hex');

/**
 * Process-local auth primitives shared by the opt-in operator credential HTTP
 * controller. Proposal capability is separate from read; approvals and MCP
 * transport remain disabled and all write routes require independent opt-in.
 * Restart/disable/operator-secret rotation invalidates all active tokens.
 */
export class MemoryAuthorizationService {
  private readonly credentials = new Map<string, Credential>();
  private readonly grants = new Map<string, Grant>();
  private readonly events: MemorySecurityAuditEvent[] = [];
  private previousConfigDigest: string | null = null;
  private attemptWindow = 0;
  private failedOperatorAttempts = 0;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly clock: () => number = Date.now,
  ) {}

  private clear(): void {
    this.credentials.clear();
    this.grants.clear();
  }

  private config(): MemorySecurityConfiguration {
    let config: MemorySecurityConfiguration;
    try {
      config = memorySecurityConfig(this.env);
    } catch (error) {
      this.clear();
      this.previousConfigDigest = null;
      throw error;
    }
    const fingerprint = key(
      JSON.stringify([
        config.operatorSecret,
        config.repositories,
        config.trustedOrigin,
        config.externalReadEnabled,
        config.proposalWriteEnabled,
      ]),
    );
    if (this.previousConfigDigest !== null && this.previousConfigDigest !== fingerprint) {
      this.clear(); // revoked immediately on any configuration change, even secret rotation
    }
    this.previousConfigDigest = fingerprint;
    this.expire();
    return config;
  }

  private expire(): void {
    const now = this.clock();
    for (const [token, credential] of this.credentials) {
      if (now >= credential.expiresAt) this.credentials.delete(token);
    }
    for (const [token, grant] of this.grants) {
      if (now >= grant.expiresAt) this.grants.delete(token);
    }
  }

  private authenticateOperator(config: MemorySecurityConfiguration, supplied: unknown): void {
    const now = this.clock();
    if (now - this.attemptWindow >= 60_000 || now < this.attemptWindow) {
      this.attemptWindow = now;
      this.failedOperatorAttempts = 0;
    }
    if (this.failedOperatorAttempts >= OPERATOR_ATTEMPTS_PER_MINUTE) {
      throw new MemorySecurityError('rate-limited');
    }
    const value = typeof supplied === 'string' && supplied.length <= 256 ? supplied : '';
    if (!timingSafeEqual(hash(config.operatorSecret), hash(value))) {
      this.failedOperatorAttempts++;
      throw new MemorySecurityError('unauthorized');
    }
  }

  private checkRepository(config: MemorySecurityConfiguration, repository: string): void {
    if (!config.repositories.includes(repository)) throw new MemorySecurityError('forbidden');
  }

  private audit(
    event: MemorySecurityAuditEvent['event'],
    repository: string,
    resourceId: string,
  ): void {
    this.events.push({
      event,
      actorId: 'local-operator',
      repository,
      resourceId,
      at: new Date(this.clock()).toISOString(),
    });
    if (this.events.length > MAX_AUDIT) this.events.shift();
  }

  /** Dedicated memory control-plane authentication; no shell, Git or worktree grants. */
  assertOperatorForCredentialRequest(secret: unknown): void {
    this.authenticateOperator(this.config(), secret);
  }

  /** Exposes only non-secret, bounded metadata; does not write credentials to disk. */
  auditSnapshot(): readonly MemorySecurityAuditEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  provisionReadCredential(
    operatorSecret: string,
    input: unknown,
  ): {
    credentialId: string;
    bearerToken: string;
    expiresAt: string;
    permission: 'READ_VERIFIED' | 'PROPOSE_MEMORY';
  } {
    const config = this.config();
    this.authenticateOperator(config, operatorSecret);
    const parsed = credentialInputSchema.safeParse(input);
    if (!parsed.success) throw new MemorySecurityError('forbidden');
    const target = parsed.data;
    const permission = target.permission ?? 'READ_VERIFIED';
    this.checkRepository(config, target.repository);
    if (
      target.kind === 'external' &&
      (!config.externalReadEnabled || target.agentId || target.sessionId)
    ) {
      throw new MemorySecurityError('forbidden');
    }
    // No repository-wide or task-only agent credentials: every agent is
    // tied to a concrete, independently DB-validated task AND session.
    if (target.kind === 'agent' && (!target.agentId || !target.taskId || !target.sessionId))
      throw new MemorySecurityError('forbidden');
    if (target.sessionId && !target.taskId) throw new MemorySecurityError('forbidden');
    if (permission === 'PROPOSE_MEMORY' && !config.proposalWriteEnabled)
      throw new MemorySecurityError('disabled');
    if (target.kind === 'external' && permission !== 'READ_VERIFIED')
      throw new MemorySecurityError('forbidden');
    if (target.kind === 'external' && target.ttlSeconds > 300)
      throw new MemorySecurityError('forbidden');
    if (this.credentials.size >= MAX_CREDENTIALS) throw new MemorySecurityError('rate-limited');
    const credentialId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    this.credentials.set(key(token), {
      id: credentialId,
      type: target.kind,
      repository: target.repository,
      ...(target.agentId ? { agentId: target.agentId } : {}),
      ...(target.taskId ? { taskId: target.taskId } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      permission,
      expiresAt: this.clock() + target.ttlSeconds * 1000,
    });
    this.audit('credential-issued', target.repository, credentialId);
    return {
      credentialId,
      bearerToken: token,
      expiresAt: new Date(this.clock() + target.ttlSeconds * 1000).toISOString(),
      permission,
    };
  }

  /** Only a validated bearer, NEVER a repository/query parameter, supplies memory read context. */
  authenticateReadBearer(token: unknown): MemoryPrincipal {
    const config = this.config();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new MemorySecurityError('unauthorized');
    }
    const credential = this.credentials.get(key(token));
    if (!credential || this.clock() >= credential.expiresAt)
      throw new MemorySecurityError('unauthorized');
    this.checkRepository(config, credential.repository);
    if (credential.permission !== 'READ_VERIFIED') throw new MemorySecurityError('forbidden');
    if (credential.type === 'external' && !config.externalReadEnabled)
      throw new MemorySecurityError('unauthorized');
    const readContext = MemoryReadContextSchema.parse({
      repository: credential.repository,
      taskId: credential.taskId,
      sessionId: credential.sessionId,
      agentId: credential.agentId,
    });
    return {
      type: credential.type,
      actorId: credential.id,
      repository: credential.repository,
      permission: 'READ_VERIFIED',
      readContext,
    };
  }

  /**
   * Proposal-only capability is deliberately disjoint from READ_VERIFIED.
   * Possessing a read bearer can never authorize a write, even on loopback.
   */
  authenticateProposalBearer(token: unknown): MemoryPrincipal {
    const config = this.config();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new MemorySecurityError('unauthorized');
    const credential = this.credentials.get(key(token));
    if (!credential || this.clock() >= credential.expiresAt)
      throw new MemorySecurityError('unauthorized');
    if (credential.type !== 'agent' || credential.permission !== 'PROPOSE_MEMORY')
      throw new MemorySecurityError('forbidden');
    this.checkRepository(config, credential.repository);
    if (!credential.agentId || !credential.taskId || !credential.sessionId)
      throw new MemorySecurityError('forbidden');
    return {
      type: 'agent',
      actorId: credential.id,
      repository: credential.repository,
      permission: 'PROPOSE_MEMORY',
      readContext: MemoryReadContextSchema.parse({
        repository: credential.repository,
        agentId: credential.agentId,
        taskId: credential.taskId,
        sessionId: credential.sessionId,
      }),
    };
  }

  revokeCredential(operatorSecret: string, credentialId: string): boolean {
    const config = this.config();
    this.authenticateOperator(config, operatorSecret);
    if (!uuid.safeParse(credentialId).success) throw new MemorySecurityError('forbidden');
    for (const [token, credential] of this.credentials) {
      if (credential.id === credentialId) {
        this.credentials.delete(token);
        this.audit('credential-revoked', credential.repository, credential.id);
        return true;
      }
    }
    return false;
  }

  issueOperatorApprovalGrant(
    operatorSecret: string,
    rawIntent: unknown,
  ): {
    grantId: string;
    grantToken: string;
    expiresAt: string;
    action: MemoryGrantIntent['action'];
  } {
    const config = this.config();
    this.authenticateOperator(config, operatorSecret);
    const parsed = grantInputSchema.safeParse(rawIntent);
    if (!parsed.success) throw new MemorySecurityError('forbidden');
    const intent = parsed.data;
    this.checkRepository(config, intent.repository);
    if (this.grants.size >= MAX_GRANTS) throw new MemorySecurityError('rate-limited');
    const grantId = randomUUID();
    const grantToken = randomBytes(32).toString('base64url');
    const expiresAt = this.clock() + GRANT_TTL_MS;
    this.grants.set(key(grantToken), { ...intent, id: grantId, expiresAt });
    this.audit('grant-issued', intent.repository, grantId);
    return {
      grantId,
      grantToken,
      expiresAt: new Date(expiresAt).toISOString(),
      action: intent.action,
    };
  }

  /** Synchronous, one-use CAS for future #40 guarded DB mutation. No DB write here. */
  consumeOperatorApprovalGrant(
    operatorSecret: string,
    token: unknown,
    rawIntent: unknown,
  ): boolean {
    const config = this.config();
    this.authenticateOperator(config, operatorSecret);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new MemorySecurityError('forbidden');
    }
    const tokenKey = key(token);
    const grant = this.grants.get(tokenKey);
    this.grants.delete(tokenKey); // consume before all further checks, even on mismatch
    if (!grant) throw new MemorySecurityError('forbidden');
    const parsed = grantInputSchema.safeParse(rawIntent);
    if (
      !parsed.success ||
      this.clock() >= grant.expiresAt ||
      Object.keys(parsed.data).some(
        (field) =>
          parsed.data[field as keyof MemoryGrantIntent] !== grant[field as keyof MemoryGrantIntent],
      ) ||
      !config.repositories.includes(grant.repository)
    ) {
      this.audit('grant-denied', grant.repository, grant.id);
      throw new MemorySecurityError('forbidden');
    }
    this.audit('grant-consumed', grant.repository, grant.id);
    return true;
  }

  revokeOperatorGrant(operatorSecret: string, grantId: string): boolean {
    const config = this.config();
    this.authenticateOperator(config, operatorSecret);
    if (!uuid.safeParse(grantId).success) throw new MemorySecurityError('forbidden');
    for (const [token, grant] of this.grants) {
      if (grant.id === grantId) {
        this.grants.delete(token);
        this.audit('grant-revoked', grant.repository, grant.id);
        return true;
      }
    }
    return false;
  }
}
