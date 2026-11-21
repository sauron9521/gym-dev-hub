import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type pg from 'pg';
import postgres from 'pg';
import { z } from 'zod';
import { resolveMemoryDatabaseConfiguration } from '../database/memory-database-policy.js';
import type { MemoryDatabasePurpose } from '../database/memory-database-policy.js';
import { MemoryAuthorizationService } from '../security/memory-authorization.service.js';
import {
  authenticateMemoryHttpProposal,
  toMemoryHttpException,
} from '../security/memory-http-identity.js';
import type { MemoryHttpReadRequest } from '../security/memory-http-identity.js';
import { verifyMemoryPrincipalBinding } from '../security/memory-principal-binding.js';
import { MemorySecurityError } from '../security/memory-security-policy.js';

const uuid = z.uuid();
const proposalSchema = z.strictObject({
  kind: z.enum(['fact', 'decision', 'constraint']),
  text: z.string().trim().min(1).max(4096),
  sourceRef: z
    .string()
    .trim()
    .min(3)
    .max(256)
    .regex(/^[^\r\n\0]+$/),
});
const leakedCredential =
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9_]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\b(?:password|api[_-]?key|secret|token)\s*[:=]\s*\S{8,}/i;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type PoolFactory = (url: string) => pg.Pool;
export type MemoryProposalReceipt = {
  recordId: string;
  status: 'PROPOSED';
  revision: 1;
  replayed: boolean;
};

/**
 * Proposal-only, independently gated local write. All trusted identity fields
 * come from the operator-issued session-bound Bearer, NEVER from request body.
 * An append-only proposal is not verified knowledge and never enters reads.
 */
export class MemoryProposalService {
  constructor(
    private readonly authorization: MemoryAuthorizationService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly makePool: PoolFactory = (url) =>
      new postgres.Pool({
        connectionString: url,
        ssl: false,
        max: 1,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 1000,
      }),
    private readonly purpose: MemoryDatabasePurpose = 'development',
  ) {}

  async propose(
    request: MemoryHttpReadRequest,
    idempotencyKey: unknown,
    body: unknown,
  ): Promise<MemoryProposalReceipt> {
    // Independent switch, never activated by a read token or security enable alone.
    if (this.env.DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE !== 'true')
      throw new ServiceUnavailableException('Memory proposals disabled');

    const principal = authenticateMemoryHttpProposal(request, this.authorization, this.env);
    const parsedKey = uuid.safeParse(idempotencyKey);
    const parsed = proposalSchema.safeParse(body);
    if (!parsedKey.success || !parsed.success)
      throw new BadRequestException('Invalid memory proposal request');
    const { kind, text, sourceRef } = parsed.data;
    if (leakedCredential.test(text) || leakedCredential.test(sourceRef))
      throw new BadRequestException('Memory proposal contains restricted credential material');

    const { repository, agentId, taskId, sessionId } = principal.readContext;
    if (!agentId || !taskId || !sessionId)
      throw toMemoryHttpException(new MemorySecurityError('forbidden'));

    const payloadDigest = digest(JSON.stringify([kind, text, sourceRef]));
    let pool: pg.Pool | undefined;
    let client: pg.PoolClient | undefined;
    let inTransaction = false;
    try {
      const config = resolveMemoryDatabaseConfiguration(this.env, this.purpose);
      if (!config.enabled) throw new MemorySecurityError('disabled');
      pool = this.makePool(config.url);
      client = await pool.connect();
      await client.query('BEGIN');
      inTransaction = true;

      // Serialize even concurrently arriving retries. A digest mismatch is
      // always a 409; the stored record is never silently overwritten.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify([repository, agentId, sessionId, parsedKey.data]),
      ]);
      // Revalidate membership WITHIN the same transaction before any write.
      await verifyMemoryPrincipalBinding(principal, client);
      const existing = await client.query<{ payload_digest: string; memory_id: string }>(
        `SELECT payload_digest, memory_id FROM memory_proposal_requests
          WHERE repository=$1 AND agent_id=$2::uuid AND session_id=$3::uuid
            AND request_key=$4::uuid FOR UPDATE`,
        [repository, agentId, sessionId, parsedKey.data],
      );
      if (existing.rows.length) {
        if (existing.rows[0]?.payload_digest !== payloadDigest)
          throw new ConflictException('Idempotency key already used for different proposal');
        await client.query('COMMIT');
        inTransaction = false;
        return {
          recordId: existing.rows[0]!.memory_id,
          status: 'PROPOSED',
          revision: 1,
          replayed: true,
        };
      }

      const recordId = randomUUID();
      const sourceId = randomUUID();
      await client.query(
        "SELECT set_config('hub.memory.actor_id',$1,true), set_config('hub.memory.source_id',$2,true)",
        [agentId, sourceId],
      );
      await client.query(
        `INSERT INTO memory_records
        (id,repository,scope,kind,status,text,revision,session_id,agent_id,updated_at)
        VALUES ($1,$2,'SESSION',$3::"MemoryKind",'PROPOSED',$4,1,$5::uuid,$6::uuid,NOW())`,
        [recordId, repository, kind.toUpperCase(), text, sessionId, agentId],
      );
      await client.query(
        `INSERT INTO memory_sources
         (id,repository,memory_id,source_type,actor_id,source_ref,observed_at)
         VALUES ($1,$2,$3,'AGENT',$4,$5,NOW())`,
        [sourceId, repository, recordId, agentId, sourceRef],
      );
      await client.query(
        `INSERT INTO memory_proposal_requests
         (repository,agent_id,session_id,request_key,payload_digest,memory_id)
         VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid)`,
        [repository, agentId, sessionId, parsedKey.data, payloadDigest, recordId],
      );
      await client.query(
        `INSERT INTO memory_mutation_audit
         (repository,memory_id,agent_id,task_id,session_id,action,previous_digest,resulting_digest)
         VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'PROPOSE_MEMORY',NULL,$6)`,
        [repository, recordId, agentId, taskId, sessionId, payloadDigest],
      );

      // All five effects and the source-linked initial immutable revision are
      // committed together, or none are persisted.
      await client.query('COMMIT');
      inTransaction = false;
      return { recordId, status: 'PROPOSED', revision: 1, replayed: false };
    } catch (error) {
      if (inTransaction && client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Never leak private DB details; pool connection is released below.
        }
      }
      if (error instanceof HttpException) throw error;
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw new ServiceUnavailableException('Memory proposal unavailable');
    } finally {
      if (client) client.release();
      if (pool) {
        try {
          await pool.end();
        } catch {
          // No DB details in HTTP errors.
        }
      }
    }
  }
}
