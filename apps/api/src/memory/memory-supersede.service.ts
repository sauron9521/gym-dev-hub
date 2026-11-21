import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import pg from 'pg';
import { z } from 'zod';
import { MemoryRepositorySchema } from '@gym-dev-hub/contracts';
import { resolveMemoryDatabaseConfiguration } from '../database/memory-database-policy.js';
import type { MemoryDatabasePurpose } from '../database/memory-database-policy.js';
import { MemoryAuthorizationService } from '../security/memory-authorization.service.js';
import { toMemoryHttpException } from '../security/memory-http-identity.js';
import { MemorySecurityError, memorySecurityConfig } from '../security/memory-security-policy.js';
import { VERIFIED_QUERY, fingerprint } from './memory-approval.service.js';

type PoolFactory = (url: string) => pg.Pool;
type VerifiedRow = Parameters<typeof fingerprint>[0];
const action = 'SUPERSEDE_MEMORY_RECORD' as const;
const requestSchema = z.strictObject({
  repository: MemoryRepositorySchema,
  recordId: z.uuid(),
  replacementRecordId: z.uuid(),
  expectedRevision: z.literal(2),
});
const commitSchema = z.strictObject({
  repository: MemoryRepositorySchema,
  replacementRecordId: z.uuid(),
  expectedRevision: z.literal(2),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
const hash = (payload: string) => createHash('sha256').update(payload).digest('hex');
const expires = (row: VerifiedRow) =>
  row.expires_at ? new Date(row.expires_at).toISOString() : null;
const intentFingerprint = (old: VerifiedRow, replacement: VerifiedRow) =>
  'sha256:' +
  hash(
    JSON.stringify([
      action,
      old.repository,
      old.id,
      old.revision,
      fingerprint(old),
      expires(old),
      replacement.id,
      replacement.revision,
      fingerprint(replacement),
      expires(replacement),
    ]),
  );

/**
 * Use already-verified, independent, source-linked memory as the replacement.
 * A supersede never edits, copies, auto-approves or broadens a proposal.
 * Original scope, task, session, agent and kind must all match exactly.
 */
export class MemorySupersedeService {
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

  private operator(secret: unknown, repository: string): string {
    this.authorization.assertOperatorForCredentialRequest(secret);
    if (typeof secret !== 'string') throw new MemorySecurityError('unauthorized');
    const conf = memorySecurityConfig(this.env);
    if (!conf.supersedeEnabled || !conf.repositories.includes(repository))
      throw new MemorySecurityError('forbidden');
    return secret;
  }

  private enabled(): void {
    if (this.env.DEV_HUB_MEMORY_SUPERSEDE_HTTP_ENABLE !== 'true')
      throw new ServiceUnavailableException('Memory supersede disabled');
  }

  private url(): string {
    const config = resolveMemoryDatabaseConfiguration(this.env, this.purpose);
    if (!config.enabled) throw new MemorySecurityError('disabled');
    return config.url;
  }

  private async loadPair(
    query: (sql: string, params: unknown[]) => Promise<{ rows: VerifiedRow[] }>,
    repository: string,
    recordId: string,
    replacementRecordId: string,
    expectedRevision: 2,
  ): Promise<{ old: VerifiedRow; replacement: VerifiedRow; digest: string }> {
    if (recordId === replacementRecordId)
      throw new ConflictException('Replacement must be a distinct verified memory record');
    const [oldResult, replacementResult] = await Promise.all([
      query(VERIFIED_QUERY, [repository, recordId, expectedRevision]),
      query(VERIFIED_QUERY, [repository, replacementRecordId, expectedRevision]),
    ]);
    const old = oldResult.rows[0],
      replacement = replacementResult.rows[0];
    if (
      oldResult.rows.length !== 1 ||
      replacementResult.rows.length !== 1 ||
      !old ||
      !replacement ||
      old.superseded_by_id != null ||
      replacement.superseded_by_id != null ||
      old.repository !== repository ||
      replacement.repository !== repository ||
      old.status !== 'VERIFIED' ||
      replacement.status !== 'VERIFIED' ||
      old.revision !== expectedRevision ||
      replacement.revision !== expectedRevision ||
      old.scope !== 'SESSION' ||
      replacement.scope !== old.scope ||
      old.kind !== replacement.kind ||
      old.task_id !== replacement.task_id ||
      old.session_id !== replacement.session_id ||
      old.agent_id !== replacement.agent_id ||
      (old.expires_at != null && new Date(old.expires_at).getTime() <= Date.now()) ||
      (replacement.expires_at != null && new Date(replacement.expires_at).getTime() <= Date.now())
    )
      throw new ConflictException('Verified memory pair unavailable or scope/version changed');

    // A single replacement may supersede at most one predecessor.
    const linked = await query(
      'SELECT id FROM memory_records WHERE repository=$1 AND superseded_by_id=$2::uuid LIMIT 1',
      [repository, replacementRecordId],
    );
    if (linked.rows.length) throw new ConflictException('Replacement already in use');

    return { old, replacement, digest: intentFingerprint(old, replacement) };
  }

  async reviewAndGrant(operatorSecret: unknown, rawInput: unknown) {
    this.enabled();
    this.authorization.assertOperatorForCredentialRequest(operatorSecret);
    const parsed = requestSchema.safeParse(rawInput);
    if (!parsed.success) throw new BadRequestException('Invalid supersede review request');
    const { repository, recordId, replacementRecordId, expectedRevision } = parsed.data;
    const secret = this.operator(operatorSecret, repository);
    let pool: pg.Pool | undefined;
    try {
      pool = this.makePool(this.url());
      const pair = await this.loadPair(
        (sql, params) => pool!.query<VerifiedRow>(sql, params),
        repository,
        recordId,
        replacementRecordId,
        expectedRevision,
      );
      const grant = this.authorization.issueOperatorApprovalGrant(secret, {
        repository,
        action,
        recordId,
        expectedRevision,
        fingerprint: pair.digest,
      });
      return {
        ...grant,
        repository,
        recordId,
        replacementRecordId,
        expectedRevision,
        fingerprint: pair.digest,
        // Both previews are explicitly untrusted material, not instructions.
        preview: {
          original: {
            kind: pair.old.kind.toLowerCase(),
            text: pair.old.text,
            sourceRef: pair.old.source_ref,
          },
          replacement: {
            kind: pair.replacement.kind.toLowerCase(),
            text: pair.replacement.text,
            sourceRef: pair.replacement.source_ref,
          },
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw new ServiceUnavailableException('Memory supersede review unavailable');
    } finally {
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* no DB details */
        }
      }
    }
  }

  async supersede(
    operatorSecret: unknown,
    grantToken: unknown,
    recordId: string,
    rawInput: unknown,
  ): Promise<{ recordId: string; status: 'SUPERSEDED'; revision: 3; supersededById: string }> {
    this.enabled();
    this.authorization.assertOperatorForCredentialRequest(operatorSecret);
    const id = z.uuid().safeParse(recordId);
    const parsed = commitSchema.safeParse(rawInput);
    if (!id.success || !parsed.success) throw new BadRequestException('Invalid supersede');
    const { repository, replacementRecordId, expectedRevision, fingerprint: digest } = parsed.data;
    const secret = this.operator(operatorSecret, repository);

    // Action/record/revision/pair-specific one-use capability is consumed before
    // any await. Failed, stale or ambiguous writes cannot silently retry.
    let grantId: string;
    try {
      grantId = this.authorization.consumeOperatorApprovalGrantWithId(secret, grantToken, {
        repository,
        action,
        recordId: id.data,
        expectedRevision,
        fingerprint: digest,
      });
    } catch (error) {
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw error;
    }

    let pool: pg.Pool | undefined;
    let client: pg.PoolClient | undefined;
    let inTransaction = false;
    try {
      pool = this.makePool(this.url());
      client = await pool.connect();
      await client.query('BEGIN');
      inTransaction = true;

      // Lock both rows in deterministic UUID order: other supersede/revoke
      // requests cannot interleave the two VERIFIED state checks.
      for (const lockedId of [recordId, replacementRecordId].sort()) {
        const lock = await client.query(
          'SELECT id FROM memory_records WHERE repository=$1 AND id=$2::uuid FOR UPDATE',
          [repository, lockedId],
        );
        if (lock.rowCount !== 1) throw new ConflictException('Memory record unavailable');
      }
      const pair = await this.loadPair(
        (sql, params) => client!.query<VerifiedRow>(sql, params),
        repository,
        recordId,
        replacementRecordId,
        expectedRevision,
      );
      if (pair.digest !== digest)
        throw new ConflictException('Memory content or provenance changed after review');

      await client.query(
        "SELECT set_config('hub.memory.actor_id',$1,true),set_config('hub.memory.source_id',$2,true),set_config('hub.memory.operator_action',$3,true)",
        ['local-operator', pair.old.source_id, action],
      );
      const updated = await client.query<{ revision: number; changed_at: Date }>(
        `UPDATE memory_records SET status='SUPERSEDED',
          superseded_by_id=$4::uuid,revision=revision+1,updated_at=NOW()
         WHERE repository=$1 AND id=$2::uuid AND revision=$3
           AND status='VERIFIED' AND scope='SESSION' AND superseded_by_id IS NULL
         RETURNING revision,updated_at AS changed_at`,
        [repository, recordId, expectedRevision, replacementRecordId],
      );
      if (updated.rowCount !== 1 || updated.rows[0]?.revision !== 3)
        throw new ConflictException('Verified memory revision changed');
      const beforeDigest = digest.slice('sha256:'.length);
      const afterDigest = hash(
        JSON.stringify([
          beforeDigest,
          'SUPERSEDED',
          3,
          replacementRecordId,
          'local-operator',
          new Date(updated.rows[0].changed_at).toISOString(),
        ]),
      );
      await client.query(
        `INSERT INTO memory_mutation_audit
          (repository,memory_id,agent_id,task_id,session_id,action,
           previous_digest,resulting_digest,operator_actor_id,grant_id)
         VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
           'SUPERSEDE_MEMORY_RECORD',$6,$7,'local-operator',$8::uuid)`,
        [
          repository,
          recordId,
          pair.old.agent_id,
          pair.old.task_id,
          pair.old.session_id,
          beforeDigest,
          afterDigest,
          grantId,
        ],
      );
      await client.query('COMMIT');
      inTransaction = false;
      return { recordId, status: 'SUPERSEDED', revision: 3, supersededById: replacementRecordId };
    } catch (error) {
      if (inTransaction && client) {
        try {
          await client.query('ROLLBACK');
        } catch {}
      }
      if (error instanceof HttpException) throw error;
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      if (error instanceof Error && 'code' in error && error.code === '23505')
        throw new ConflictException('Replacement already in use');
      throw new ServiceUnavailableException('Memory supersede unavailable');
    } finally {
      if (client) client.release();
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* no DB details */
        }
      }
    }
  }
}
