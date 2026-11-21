import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import pg from 'pg';
import { z } from 'zod';
import { MemoryRepositorySchema } from '@gym-dev-hub/contracts';
import { resolveMemoryDatabaseConfiguration } from '../database/memory-database-policy.js';
import type { MemoryDatabasePurpose } from '../database/memory-database-policy.js';
import {
  MemoryOperatorIdentityService,
  operatorTokenDigest,
} from '../security/memory-operator-identity.service.js';
import { memorySecurityConfig } from '../security/memory-security-policy.js';
import { PROPOSAL_QUERY, fingerprint } from './memory-approval.service.js';

const action = 'REJECT_MEMORY_PROPOSAL';
const reviewSchema = z.strictObject({
  repository: MemoryRepositorySchema,
  recordId: z.uuid(),
  expectedRevision: z.literal(1),
});
const commitSchema = z.strictObject({
  repository: MemoryRepositorySchema,
  expectedRevision: z.literal(1),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
type Proposal = Parameters<typeof fingerprint>[0] & {
  source_id: string;
  source_ref: string;
  kind: string;
  agent_id: string;
  task_id: string;
  session_id: string;
};
type Grant = {
  id: string;
  identityId: string;
  credentialDigest: string;
  repository: string;
  recordId: string;
  expectedRevision: 1;
  fingerprint: string;
  expiresAt: number;
};
type PoolFactory = (url: string) => pg.Pool;
const sha = (input: string) => createHash('sha256').update(input).digest('hex');
const constantEquals = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(sha(a), 'hex'), Buffer.from(sha(b), 'hex'));

/** Narrow PERSONAL rejection only; existing personal approvals are a later PR.
 * Any change to identity, role, or repository is read from DB, not body text.
 * One-use grant is bound to exact credential token digest AND identity UUID.
 */
export class MemoryPersonalRejectionService {
  private readonly grants = new Map<string, Grant>();
  private previousConfig: string | null = null;
  constructor(
    private readonly identities: MemoryOperatorIdentityService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly poolFactory: PoolFactory = (url) =>
      new pg.Pool({
        connectionString: url,
        ssl: false,
        max: 1,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 1000,
      }),
    private readonly purpose: MemoryDatabasePurpose = 'development',
    private readonly now: () => number = Date.now,
  ) {}

  private enabled(repository?: string) {
    // Configuration rotation and disabling a flag invalidates all pending grants.
    let config;
    try {
      config = memorySecurityConfig(this.env);
      if (
        !config.personalRejectionEnabled ||
        !config.operatorIdentityEnabled ||
        !config.rejectionWriteEnabled
      )
        throw new ServiceUnavailableException('Personal memory rejection disabled');
      if (repository && !config.repositories.includes(repository))
        throw new ForbiddenException('Repository not allowed');
    } catch (error) {
      this.grants.clear();
      this.previousConfig = null;
      throw error;
    }
    const signature = sha(
      JSON.stringify([
        config.operatorSecret,
        config.repositories,
        config.trustedOrigin,
        config.personalRejectionEnabled,
        config.personalApprovalEnabled,
        config.operatorIdentityEnabled,
        config.rejectionWriteEnabled,
      ]),
    );
    if (this.previousConfig !== null && this.previousConfig !== signature) this.grants.clear();
    this.previousConfig = signature;
    for (const [key, grant] of this.grants)
      if (this.now() >= grant.expiresAt) this.grants.delete(key);
    return config;
  }

  private url() {
    const result = resolveMemoryDatabaseConfiguration(this.env, this.purpose);
    if (!result.enabled) throw new ServiceUnavailableException('Personal memory DB disabled');
    return result.url;
  }

  async reviewAndGrant(token: unknown, rawInput: unknown) {
    this.enabled();
    const parsed = reviewSchema.safeParse(rawInput);
    if (!parsed.success) throw new BadRequestException('Invalid personal rejection review request');
    const { repository, recordId, expectedRevision } = parsed.data;
    this.enabled(repository);
    // Full per-request PostgreSQL check includes current role, expiry and revoke.
    const principal = await this.identities.verify(token, repository, action);
    if (typeof token !== 'string') throw new ForbiddenException('Operator bearer required');
    let pool: pg.Pool | undefined;
    try {
      pool = this.poolFactory(this.url());
      const result = await pool.query<Proposal>(PROPOSAL_QUERY, [
        repository,
        recordId,
        expectedRevision,
      ]);
      if (result.rows.length !== 1)
        throw new ConflictException('Proposal unavailable or revision changed');
      const row = result.rows[0]!;
      if (this.grants.size >= 64)
        throw new ServiceUnavailableException('Personal grants exhausted');
      const grantToken = randomBytes(32).toString('base64url');
      const grant: Grant = {
        id: randomUUID(),
        identityId: principal.identityId,
        credentialDigest: operatorTokenDigest(token),
        repository,
        recordId,
        expectedRevision,
        fingerprint: fingerprint(row),
        expiresAt: this.now() + 45_000,
      };
      this.grants.set(sha(grantToken), grant);
      return {
        grantToken,
        grantId: grant.id,
        action,
        repository,
        recordId,
        expectedRevision,
        fingerprint: grant.fingerprint,
        expiresAt: new Date(grant.expiresAt).toISOString(),
        operatorIdentityId: principal.identityId,
        preview: { kind: row.kind.toLowerCase(), text: row.text, sourceRef: row.source_ref },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Personal memory rejection review unavailable');
    } finally {
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* no connection information */
        }
      }
    }
  }

  async reject(
    token: unknown,
    rawGrant: unknown,
    recordId: string,
    rawInput: unknown,
  ): Promise<{ recordId: string; status: 'REVOKED'; revision: 2 }> {
    this.enabled();
    const id = z.uuid().safeParse(recordId);
    const parsed = commitSchema.safeParse(rawInput);
    if (!id.success || !parsed.success) throw new BadRequestException('Invalid personal rejection');
    const { repository, expectedRevision, fingerprint: expectedFingerprint } = parsed.data;
    this.enabled(repository);

    // Consume ONE grant synchronously before the first async DB operation, even
    // on a mismatched operator bearer, actor, action, record or fingerprint.
    if (typeof rawGrant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawGrant))
      throw new ForbiddenException('Personal rejection grant required');
    const key = sha(rawGrant);
    const grant = this.grants.get(key);
    this.grants.delete(key);
    if (
      !grant ||
      typeof token !== 'string' ||
      !/^mop_[A-Za-z0-9_-]{43}$/.test(token) ||
      this.now() >= grant.expiresAt ||
      grant.repository !== repository ||
      grant.recordId !== id.data ||
      grant.expectedRevision !== expectedRevision ||
      grant.fingerprint !== expectedFingerprint ||
      !constantEquals(operatorTokenDigest(token), grant.credentialDigest)
    )
      throw new ForbiddenException('Personal rejection grant unavailable');

    let pool: pg.Pool | undefined,
      client: pg.PoolClient | undefined,
      started = false;
    try {
      pool = this.poolFactory(this.url());
      client = await pool.connect();
      await client.query('BEGIN');
      started = true;
      // The DB share-lock ensures a concurrent identity revoke waits until this
      // decision finishes; if revoke commits first the action fails closed.
      const actor = await client.query<{ id: string; role: string }>(
        `SELECT id,role FROM memory_operator_identities
         WHERE repository=$1 AND id=$2::uuid AND token_digest=$3
           AND role='REVIEWER' AND revoked_at IS NULL AND expires_at>clock_timestamp()
         FOR SHARE`,
        [repository, grant.identityId, operatorTokenDigest(token)],
      );
      if (actor.rows.length !== 1)
        throw new ForbiddenException('Operator credential revoked or insufficient');
      const current = await client.query<Proposal>(PROPOSAL_QUERY + ' FOR UPDATE OF r', [
        repository,
        recordId,
        expectedRevision,
      ]);
      const row = current.rows[0];
      if (current.rows.length !== 1 || !row || fingerprint(row) !== expectedFingerprint)
        throw new ConflictException('Proposal unavailable or revision changed');

      const actorLabel = 'operator:' + grant.identityId;
      await client.query(
        "SELECT set_config('hub.memory.actor_id',$1,true),set_config('hub.memory.source_id',$2,true),set_config('hub.memory.operator_action',$3,true)",
        [actorLabel, row.source_id, action],
      );
      const changed = await client.query<{ revision: number; changed_at: Date }>(
        `UPDATE memory_records SET status='REVOKED',revision=revision+1,updated_at=NOW()
         WHERE repository=$1 AND id=$2::uuid AND revision=$3 AND status='PROPOSED' AND scope='SESSION'
         RETURNING revision,updated_at AS changed_at`,
        [repository, recordId, expectedRevision],
      );
      if (changed.rowCount !== 1 || changed.rows[0]?.revision !== 2)
        throw new ConflictException('Proposal unavailable or revision changed');
      const beforeDigest = expectedFingerprint.slice(7);
      const afterDigest = sha(
        JSON.stringify([
          beforeDigest,
          'REVOKED',
          2,
          actorLabel,
          new Date(changed.rows[0].changed_at).toISOString(),
        ]),
      );
      await client.query(
        `INSERT INTO memory_mutation_audit
           (repository,memory_id,agent_id,task_id,session_id,action,
            previous_digest,resulting_digest,operator_actor_id,operator_identity_id,grant_id)
         VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
           'REJECT_MEMORY_PROPOSAL',$6,$7,$8,$9::uuid,$10::uuid)`,
        [
          repository,
          recordId,
          row.agent_id,
          row.task_id,
          row.session_id,
          beforeDigest,
          afterDigest,
          actorLabel,
          grant.identityId,
          grant.id,
        ],
      );
      // Use the wall clock again at commit, not transaction-start NOW(),
      // so a reviewer expiring while waiting on row locks fails closed.
      const stillValid = await client.query<{ id: string }>(
        `SELECT id FROM memory_operator_identities
         WHERE repository=$1 AND id=$2::uuid AND token_digest=$3
           AND role='REVIEWER' AND revoked_at IS NULL
           AND expires_at>clock_timestamp()`,
        [repository, grant.identityId, operatorTokenDigest(token)],
      );
      if (stillValid.rowCount !== 1) throw new ForbiddenException('Operator credential expired');
      await client.query('COMMIT');
      started = false;
      return { recordId, status: 'REVOKED', revision: 2 };
    } catch (error) {
      if (started && client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* no SQL detail */
        }
      }
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Personal memory rejection unavailable');
    } finally {
      if (client) client.release();
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* no connection information */
        }
      }
    }
  }
}
