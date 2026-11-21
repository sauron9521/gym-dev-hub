import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import pg from 'pg';
import { MemoryRepositorySchema } from '@gym-dev-hub/contracts';
import { resolveMemoryDatabaseConfiguration } from '../database/memory-database-policy.js';
import type { MemoryDatabasePurpose } from '../database/memory-database-policy.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import {
  MemorySecurityError,
  memorySecurityConfig,
  assertMemoryLocalBoundary,
} from './memory-security-policy.js';
import type { LocalMemoryHttpRequest } from './memory-security-policy.js';
import { toMemoryHttpException } from './memory-http-identity.js';

type PoolFactory = (url: string) => pg.Pool;
const handleSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,47}$/);
const issueSchema = z.strictObject({
  repository: MemoryRepositorySchema,
  handle: handleSchema,
  role: z.enum(['REVIEWER', 'AUDITOR']),
  ttlSeconds: z.number().int().min(60).max(86400),
});
const whoamiSchema = z.strictObject({ repository: MemoryRepositorySchema });
const uuidSchema = z.uuid();
export type MemoryOperatorRole = 'REVIEWER' | 'AUDITOR';
export type MemoryOperatorPermission =
  | 'READ_OPERATOR_METADATA'
  | 'APPROVE_MEMORY_PROPOSAL'
  | 'REJECT_MEMORY_PROPOSAL'
  | 'REVOKE_MEMORY_RECORD'
  | 'SUPERSEDE_MEMORY_RECORD';

const rolePermissions: Record<MemoryOperatorRole, readonly MemoryOperatorPermission[]> = {
  AUDITOR: ['READ_OPERATOR_METADATA'],
  REVIEWER: [
    'READ_OPERATOR_METADATA',
    'APPROVE_MEMORY_PROPOSAL',
    'REJECT_MEMORY_PROPOSAL',
    'REVOKE_MEMORY_RECORD',
    'SUPERSEDE_MEMORY_RECORD',
  ],
};
type IdentityRow = {
  id: string;
  repository: string;
  handle: string;
  role: MemoryOperatorRole;
  expires_at: Date;
  revoked_at: Date | null;
};
const digest = (token: string) =>
  createHash('sha256')
    .update('gym-dev-hub:operator-identity:v1\0', 'utf8')
    .update(token, 'utf8')
    .digest('hex');

/**
 * Independently opted-in individual credential holders, stored in dedicated Hub
 * DB. Root operator secret is only a bootstrap credential; no agent can mint
 * or impersonate a reviewer. Unlike in-process memory grants, these identities
 * survive process restart but EVERY bearer check re-reads the DB for revocation.
 *
 * Important: a handle names the person who received a credential; it does not
 * itself provide proof of a unique natural person. Human verification / MFA,
 * and wiring personal identity into approval revision/audit, are separate PRs.
 */
export class MemoryOperatorIdentityService {
  constructor(
    private readonly authorization: MemoryAuthorizationService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly makePool: PoolFactory = (url) =>
      new pg.Pool({
        connectionString: url,
        ssl: false,
        max: 1,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 1000,
      }),
    private readonly purpose: MemoryDatabasePurpose = 'development',
  ) {}

  assertLocalHttp(request: LocalMemoryHttpRequest) {
    assertMemoryLocalBoundary(request, memorySecurityConfig(this.env).trustedOrigin);
    if (request.path.includes('?')) throw new MemorySecurityError('forbidden');
  }

  private config(repository?: string) {
    if (this.env.DEV_HUB_MEMORY_OPERATOR_IDENTITIES_HTTP_ENABLE !== 'true')
      throw new ServiceUnavailableException('Operator identities disabled');
    const config = memorySecurityConfig(this.env);
    if (!config.operatorIdentityEnabled)
      throw new ServiceUnavailableException('Operator identities disabled');
    if (repository && !config.repositories.includes(repository))
      throw new ForbiddenException('Repository not allowed');
    return config;
  }

  private url() {
    const db = resolveMemoryDatabaseConfiguration(this.env, this.purpose);
    if (!db.enabled) throw new MemorySecurityError('disabled');
    return db.url;
  }

  private root(secret: unknown): void {
    this.authorization.assertOperatorForCredentialRequest(secret);
  }

  /** Returns a 256-bit secret ONCE; never persists, logs or re-reads its bytes. */
  async issue(
    secret: unknown,
    input: unknown,
  ): Promise<{
    identityId: string;
    repository: string;
    handle: string;
    role: MemoryOperatorRole;
    bearerToken: string;
    expiresAt: string;
  }> {
    this.config();
    this.root(secret);
    const parsed = issueSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Invalid operator identity request');
    const { repository, handle, role, ttlSeconds } = parsed.data;
    this.config(repository);
    const bearerToken = 'mop_' + randomBytes(32).toString('base64url');
    let pool: pg.Pool | undefined;
    let client: pg.PoolClient | undefined;
    let started = false;
    try {
      pool = this.makePool(this.url());
      client = await pool.connect();
      await client.query('BEGIN');
      started = true;
      // Repository is independently registered by trusted control plane.
      const row = await client.query<IdentityRow>(
        `INSERT INTO memory_operator_identities
           (repository,handle,role,token_digest,expires_at)
         VALUES ($1,$2,$3,$4,NOW() + ($5::int * interval '1 second'))
         RETURNING id,repository,handle,role,expires_at,revoked_at`,
        [repository, handle, role, digest(bearerToken), ttlSeconds],
      );
      const identity = row.rows[0];
      if (!identity || row.rowCount !== 1) throw Error('Failed identity creation');
      await client.query(
        `INSERT INTO memory_operator_identity_audit
           (repository,operator_id,action,actor)
         VALUES ($1,$2::uuid,'ISSUED','bootstrap-root')`,
        [repository, identity.id],
      );
      await client.query('COMMIT');
      started = false;
      return {
        identityId: identity.id,
        repository: identity.repository,
        handle: identity.handle,
        role: identity.role,
        bearerToken,
        expiresAt: new Date(identity.expires_at).toISOString(),
      };
    } catch (error) {
      if (started && client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* never expose DB details */
        }
      }
      if (error instanceof HttpException) throw error;
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      if (error instanceof Error && 'code' in error && error.code === '23505')
        throw new ConflictException('Operator handle already registered');
      throw new ServiceUnavailableException('Operator identity issuance unavailable');
    } finally {
      if (client) client.release();
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* redacted */
        }
      }
    }
  }

  /** Root revocation takes effect immediately across all processes and restarts. */
  async revoke(secret: unknown, rawId: unknown, input: unknown): Promise<{ revoked: boolean }> {
    this.config();
    this.root(secret);
    const parsed = whoamiSchema.safeParse(input);
    const id = uuidSchema.safeParse(rawId);
    if (!parsed.success || !id.success)
      throw new BadRequestException('Invalid identity revocation');
    const repository = parsed.data.repository;
    this.config(repository);
    let pool: pg.Pool | undefined,
      client: pg.PoolClient | undefined,
      started = false;
    try {
      pool = this.makePool(this.url());
      client = await pool.connect();
      await client.query('BEGIN');
      started = true;
      const result = await client.query<{ id: string }>(
        `UPDATE memory_operator_identities SET revoked_at=NOW()
         WHERE repository=$1 AND id=$2::uuid AND revoked_at IS NULL
         RETURNING id`,
        [repository, id.data],
      );
      if (result.rowCount === 1) {
        await client.query(
          `INSERT INTO memory_operator_identity_audit
             (repository,operator_id,action,actor)
           VALUES ($1,$2::uuid,'REVOKED','bootstrap-root')`,
          [repository, id.data],
        );
      }
      await client.query('COMMIT');
      started = false;
      return { revoked: result.rowCount === 1 };
    } catch (error) {
      if (started && client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* redacted */
        }
      }
      if (error instanceof HttpException) throw error;
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw new ServiceUnavailableException('Operator identity revocation unavailable');
    } finally {
      if (client) client.release();
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* redacted */
        }
      }
    }
  }

  /**
   * DB-backed role+repository check for a later operator-decision integration.
   * NEVER trust an actor ID/role supplied by a body, Origin or bearer prefix.
   */
  async verify(
    token: unknown,
    repository: unknown,
    action: MemoryOperatorPermission,
  ): Promise<{
    identityId: string;
    repository: string;
    handle: string;
    role: MemoryOperatorRole;
    permissions: readonly MemoryOperatorPermission[];
  }> {
    this.config();
    const repo = MemoryRepositorySchema.safeParse(repository);
    if (!repo.success) throw new BadRequestException('Invalid repository');
    this.config(repo.data);
    if (typeof token !== 'string' || !/^mop_[A-Za-z0-9_-]{43}$/.test(token))
      throw new UnauthorizedException('Operator identity credential required');
    let pool: pg.Pool | undefined;
    try {
      pool = this.makePool(this.url());
      const result = await pool.query<IdentityRow>(
        `SELECT id,repository,handle,role,expires_at,revoked_at
         FROM memory_operator_identities
         WHERE repository=$1 AND token_digest=$2
           AND revoked_at IS NULL AND expires_at > NOW()
         LIMIT 1`,
        [repo.data, digest(token)],
      );
      const identity = result.rows[0];
      if (!identity || result.rows.length !== 1)
        throw new UnauthorizedException('Operator identity unavailable');
      const permissions = rolePermissions[identity.role];
      if (!permissions || !permissions.includes(action))
        throw new ForbiddenException('Operator role is insufficient');
      return {
        identityId: identity.id,
        repository: identity.repository,
        handle: identity.handle,
        role: identity.role,
        permissions,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw new ServiceUnavailableException('Operator identity check unavailable');
    } finally {
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* redacted */
        }
      }
    }
  }

  async whoami(token: unknown, input: unknown) {
    const parsed = whoamiSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Invalid operator repository');
    return this.verify(token, parsed.data.repository, 'READ_OPERATOR_METADATA');
  }
}
