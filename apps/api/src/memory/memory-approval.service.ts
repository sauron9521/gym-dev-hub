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
import {
  assertMemoryLocalBoundary,
  MemorySecurityError,
  memorySecurityConfig,
} from '../security/memory-security-policy.js';
import type { LocalMemoryHttpRequest } from '../security/memory-security-policy.js';

type PoolFactory = (url: string) => pg.Pool;
const reviewSchema = z.strictObject({
  repository: MemoryRepositorySchema,
  recordId: z.uuid(),
  expectedRevision: z.literal(1),
});
const approveSchema = z.strictObject({
  repository: MemoryRepositorySchema,
  expectedRevision: z.literal(1),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

type ProposalRow = {
  id: string;
  repository: string;
  kind: string;
  scope: string;
  status: string;
  revision: number;
  text: string;
  session_id: string;
  agent_id: string;
  task_id: string;
  source_id: string;
  source_ref: string;
};
type ApprovedRow = { revision: number; verified_at: Date };
const sha = (input: string) => createHash('sha256').update(input).digest('hex');
const fingerprint = (row: ProposalRow) =>
  'sha256:' +
  sha(
    JSON.stringify([
      row.repository,
      row.id,
      row.revision,
      row.status,
      row.scope,
      row.kind,
      row.text,
      row.task_id,
      row.session_id,
      row.agent_id,
      row.source_id,
      row.source_ref,
    ]),
  );

const PROPOSAL_QUERY = `
  SELECT r.id,r.repository,r.kind::text,r.scope::text,r.status::text,
    r.revision,r.text,r.session_id,r.agent_id,ms.task_id,
    s.id AS source_id,s.source_ref
  FROM memory_records r
  JOIN memory_sessions ms ON ms.repository=r.repository
    AND ms.id=r.session_id AND ms.agent_id=r.agent_id AND ms.task_id IS NOT NULL
  JOIN memory_tasks t ON t.repository=r.repository AND t.id=ms.task_id
  JOIN memory_agent_identities a ON a.repository=r.repository AND a.id=r.agent_id
  JOIN memory_sources s ON s.repository=r.repository AND s.memory_id=r.id
    AND s.source_type='AGENT' AND s.actor_id=r.agent_id::text
  JOIN memory_revisions v ON v.repository=r.repository AND v.memory_id=r.id
    AND v.revision=1 AND v.status='PROPOSED' AND v.source_id=s.id
    AND v.scope=r.scope AND v.kind=r.kind AND v.text=r.text
  JOIN memory_proposal_requests pr ON pr.repository=r.repository
    AND pr.memory_id=r.id AND pr.agent_id=r.agent_id AND pr.session_id=r.session_id
  JOIN memory_mutation_audit a0 ON a0.repository=r.repository AND a0.memory_id=r.id
    AND a0.action='PROPOSE_MEMORY' AND a0.agent_id=r.agent_id
    AND a0.session_id=r.session_id AND a0.task_id=ms.task_id
  WHERE r.repository=$1 AND r.id=$2::uuid AND r.revision=$3
    AND r.status='PROPOSED' AND r.scope='SESSION'
    AND (SELECT count(*) FROM memory_sources s2
      WHERE s2.repository=r.repository AND s2.memory_id=r.id)=1
`;

/**
 * Two deliberate operator actions:
 * 1. Review a particular DB-bound untrusted proposal and mint a 45-second,
 *    one-use grant tied to the exact content + original source + revision.
 * 2. Consume the grant and atomically CAS to VERIFIED with durable audit.
 *
 * No agent, read or proposal bearer is permitted here.
 * The operator identity here is deliberately "local-operator", not a claimed
 * unique human account. Per-human attribution is a separate Issue #40 gate.
 */
export class MemoryApprovalService {
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

  assertLocalOperatorHttp(request: LocalMemoryHttpRequest): void {
    assertMemoryLocalBoundary(request, memorySecurityConfig(this.env).trustedOrigin);
    // Operator grant and approval paths never accept URL query credentials.
    if (request.path.includes('?')) throw new MemorySecurityError('forbidden');
  }

  private assertEnabled(): void {
    if (this.env.DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE !== 'true')
      throw new ServiceUnavailableException('Memory approval disabled');
  }

  private assertOperator(operatorSecret: unknown, repository: string): string {
    this.authorization.assertOperatorForCredentialRequest(operatorSecret);
    if (typeof operatorSecret !== 'string') throw new MemorySecurityError('unauthorized');
    const config = memorySecurityConfig(this.env);
    if (!config.approvalWriteEnabled || !config.repositories.includes(repository))
      throw new MemorySecurityError('forbidden');
    return operatorSecret;
  }

  private databaseUrl(): string {
    const config = resolveMemoryDatabaseConfiguration(this.env, this.purpose);
    if (!config.enabled) throw new MemorySecurityError('disabled');
    return config.url;
  }

  async reviewAndGrant(operatorSecret: unknown, rawInput: unknown) {
    this.assertEnabled();
    // Authenticate operator before parsing caller's record scope or opening DB.
    this.authorization.assertOperatorForCredentialRequest(operatorSecret);
    const parsed = reviewSchema.safeParse(rawInput);
    if (!parsed.success) throw new BadRequestException('Invalid approval review request');
    const { repository, recordId, expectedRevision } = parsed.data;
    const secret = this.assertOperator(operatorSecret, repository);

    let pool: pg.Pool | undefined;
    try {
      pool = this.makePool(this.databaseUrl());
      const result = await pool.query<ProposalRow>(PROPOSAL_QUERY, [
        repository,
        recordId,
        expectedRevision,
      ]);
      if (result.rows.length !== 1)
        throw new ConflictException('Proposal unavailable or revision changed');
      const row = result.rows[0]!;
      const digest = fingerprint(row);
      const grant = this.authorization.issueOperatorApprovalGrant(secret, {
        repository,
        action: 'APPROVE_MEMORY_PROPOSAL',
        recordId,
        expectedRevision,
        fingerprint: digest,
      });
      return {
        ...grant,
        repository,
        recordId,
        expectedRevision,
        fingerprint: digest,
        // Intentionally untrusted review material, NOT runtime instructions.
        preview: { kind: row.kind.toLowerCase(), text: row.text, sourceRef: row.source_ref },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw new ServiceUnavailableException('Memory approval review unavailable');
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

  async approve(
    operatorSecret: unknown,
    grantToken: unknown,
    recordId: string,
    rawInput: unknown,
  ): Promise<{ recordId: string; status: 'VERIFIED'; revision: number }> {
    this.assertEnabled();
    this.authorization.assertOperatorForCredentialRequest(operatorSecret);
    const id = z.uuid().safeParse(recordId);
    const parsed = approveSchema.safeParse(rawInput);
    if (!id.success || !parsed.success) throw new BadRequestException('Invalid approval');
    const { repository, expectedRevision, fingerprint: approvalFingerprint } = parsed.data;
    const secret = this.assertOperator(operatorSecret, repository);

    // Consume before any await/DB operation. Wrong action/scope/expired/replayed
    // tokens are rejected and cannot be reused. A failed SQL transaction NEVER
    // silently retries or re-arms a grant.
    let grantId: string;
    try {
      grantId = this.authorization.consumeOperatorApprovalGrantWithId(secret, grantToken, {
        repository,
        action: 'APPROVE_MEMORY_PROPOSAL',
        recordId: id.data,
        expectedRevision,
        fingerprint: approvalFingerprint,
      });
    } catch (error) {
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw error;
    }

    let pool: pg.Pool | undefined;
    let client: pg.PoolClient | undefined;
    let inTransaction = false;
    try {
      pool = this.makePool(this.databaseUrl());
      client = await pool.connect();
      await client.query('BEGIN');
      inTransaction = true;

      // One row lock serializes any distinct operator grants attempting to
      // approve the same proposal concurrently; CAS rejects the loser.
      const current = await client.query<ProposalRow>(PROPOSAL_QUERY + ' FOR UPDATE OF r', [
        repository,
        recordId,
        expectedRevision,
      ]);
      const row = current.rows[0];
      if (!row || current.rows.length !== 1 || fingerprint(row) !== approvalFingerprint)
        throw new ConflictException('Proposal unavailable or revision changed');

      await client.query(
        "SELECT set_config('hub.memory.actor_id',$1,true),set_config('hub.memory.source_id',$2,true)",
        ['local-operator', row.source_id],
      );
      const result = await client.query<ApprovedRow>(
        `UPDATE memory_records SET
           status='VERIFIED',revision=revision+1,
           verified_by='local-operator',verified_at=NOW(),updated_at=NOW()
         WHERE repository=$1 AND id=$2::uuid AND revision=$3
           AND status='PROPOSED' AND scope='SESSION'
         RETURNING revision,verified_at`,
        [repository, recordId, expectedRevision],
      );
      if (result.rowCount !== 1 || !result.rows[0])
        throw new ConflictException('Proposal unavailable or revision changed');
      const after = result.rows[0]!;
      const beforeDigest = approvalFingerprint.slice('sha256:'.length);
      const afterDigest = sha(
        JSON.stringify([
          beforeDigest,
          'VERIFIED',
          after.revision,
          'local-operator',
          new Date(after.verified_at).toISOString(),
        ]),
      );
      await client.query(
        `INSERT INTO memory_mutation_audit
         (repository,memory_id,agent_id,task_id,session_id,action,
          previous_digest,resulting_digest,operator_actor_id,grant_id)
         VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
          'APPROVE_MEMORY_PROPOSAL',$6,$7,'local-operator',$8::uuid)`,
        [
          repository,
          recordId,
          row.agent_id,
          row.task_id,
          row.session_id,
          beforeDigest,
          afterDigest,
          grantId,
        ],
      );
      await client.query('COMMIT');
      inTransaction = false;
      return { recordId, status: 'VERIFIED', revision: after.revision };
    } catch (error) {
      if (inTransaction && client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* no raw SQL errors */
        }
      }
      if (error instanceof HttpException) throw error;
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw new ServiceUnavailableException('Memory approval unavailable');
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
