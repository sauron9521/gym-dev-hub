import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveMemoryDatabaseConfiguration } from '../src/database/memory-database-policy.js';
import { MemoryApprovalService } from '../src/memory/memory-approval.service.js';
import { MemorySupersedeService } from '../src/memory/memory-supersede.service.js';
import { MemoryProposalService } from '../src/memory/memory-proposal.service.js';
import { MemoryQueryService } from '../src/memory/memory-query.service.js';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';

const enabled =
  process.env.DEV_HUB_MEMORY_ENABLE === 'true' &&
  Boolean(process.env.DEV_HUB_MEMORY_TEST_DATABASE_URL);
const repository = 'sauron9521/gym-dev-hub';
const secret = 'isolated-approval-integration-secret-32bytes-long';
const taskId = randomUUID();
const agentId = randomUUID();
const sessionId = randomUUID();
const fixtureTag = randomUUID();
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_REJECTION_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_VERIFIED_REVOCATION_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_SUPERSEDE_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repository,
  DEV_HUB_MEMORY_OPERATOR_SECRET: secret,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
};
type Prepared = Awaited<ReturnType<MemoryApprovalService['reviewAndGrant']>>;
const request = (bearer: string) => ({
  method: 'POST',
  host: '127.0.0.1:3101',
  remoteAddress: '127.0.0.1',
  origin: 'http://127.0.0.1:3100',
  fetchSite: 'same-origin',
  path: '/v1/memory/proposals',
  authorization: 'Bearer ' + bearer,
});

describe.skipIf(!enabled)(
  'isolated PostgreSQL operator review, one-use grant, immutable CAS and durable audit',
  () => {
    let pool: pg.Pool;
    let auth: MemoryAuthorizationService;
    let proposer: MemoryProposalService;
    let approvals: MemoryApprovalService;
    let bearer: string;

    beforeAll(async () => {
      const config = resolveMemoryDatabaseConfiguration(process.env, 'test');
      if (!config.enabled || config.database !== 'gym_dev_hub_memory_test')
        throw Error('Refusing to test approval against a non-test DB');
      env.DEV_HUB_MEMORY_TEST_DATABASE_URL = config.url;
      pool = new pg.Pool({
        connectionString: config.url,
        ssl: false,
        max: 4,
        connectionTimeoutMillis: 4000,
      });
      const target = await pool.query('SELECT current_database() AS db');
      if (target.rows[0]?.db !== 'gym_dev_hub_memory_test')
        throw Error('Cannot test approval against dev or Gym Platform DB');
      await pool.query('INSERT INTO memory_repositories(name) VALUES($1) ON CONFLICT DO NOTHING', [
        repository,
      ]);
      await pool.query('INSERT INTO memory_tasks(id,repository,external_ref) VALUES($1,$2,$3)', [
        taskId,
        repository,
        'approval-task-' + fixtureTag,
      ]);
      await pool.query(
        'INSERT INTO memory_agent_identities(id,repository,external_ref) VALUES($1,$2,$3)',
        [agentId, repository, 'approval-agent-' + fixtureTag],
      );
      await pool.query(
        'INSERT INTO memory_sessions(id,repository,external_ref,task_id,agent_id) VALUES($1,$2,$3,$4,$5)',
        [sessionId, repository, 'approval-session-' + fixtureTag, taskId, agentId],
      );
      auth = new MemoryAuthorizationService(env);
      bearer = auth.provisionReadCredential(secret, {
        kind: 'agent',
        repository,
        agentId,
        taskId,
        sessionId,
        ttlSeconds: 300,
        permission: 'PROPOSE_MEMORY',
      }).bearerToken;
      proposer = new MemoryProposalService(auth, env, undefined, 'test');
      approvals = new MemoryApprovalService(auth, env, undefined, 'test');
    });
    afterAll(async () => {
      if (pool) await pool.end();
    });

    async function create(marker: string) {
      const payload = {
        kind: 'decision' as const,
        text: 'Untrusted proposed decision ' + marker,
        sourceRef: 'agent-session:' + sessionId,
      };
      const receipt = await proposer.propose(request(bearer), randomUUID(), payload);
      return { ...receipt, payload };
    }

    async function prepare(recordId: string): Promise<Prepared> {
      return approvals.reviewAndGrant(secret, {
        repository,
        recordId,
        expectedRevision: 1,
      });
    }

    async function approve(grant: Prepared, recordId = grant.recordId) {
      return approvals.approve(secret, grant.grantToken, recordId, {
        repository,
        expectedRevision: 1,
        fingerprint: grant.fingerprint,
      });
    }

    it('links source, operator snapshot and persistent before/after audit atomically', async () => {
      const created = await create(randomUUID());
      const ctx = { repository, agentId, taskId, sessionId };
      const query = new MemoryQueryService(pool, randomBytes(32));
      expect((await query.list(ctx, { repository })).items.map((x) => x.record.id)).not.toContain(
        created.recordId,
      );

      const grant = await prepare(created.recordId);
      expect(grant.preview).toMatchObject({
        text: created.payload.text,
        sourceRef: created.payload.sourceRef,
        kind: 'decision',
      });
      expect(grant.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      const result = await approve(grant);
      expect(result).toEqual({ recordId: created.recordId, status: 'VERIFIED', revision: 2 });
      const record = await pool.query(
        'SELECT status,revision,verified_by,verified_at,text,agent_id,session_id FROM memory_records WHERE id=$1',
        [created.recordId],
      );
      expect(record.rows).toHaveLength(1);
      expect(record.rows[0]).toMatchObject({
        status: 'VERIFIED',
        revision: 2,
        verified_by: 'local-operator',
        text: created.payload.text,
        agent_id: agentId,
        session_id: sessionId,
      });
      expect(record.rows[0].verified_at).toBeInstanceOf(Date);
      const history = await pool.query(
        'SELECT revision,status,text,source_id,changed_by FROM memory_revisions WHERE memory_id=$1 ORDER BY revision',
        [created.recordId],
      );
      expect(history.rows).toHaveLength(2);
      expect(history.rows.map((row) => row.status)).toEqual(['PROPOSED', 'VERIFIED']);
      expect(history.rows[0].source_id).toBe(history.rows[1].source_id);
      expect(history.rows[1]).toMatchObject({
        revision: 2,
        text: created.payload.text,
        changed_by: 'local-operator',
      });
      const audit = await pool.query(
        'SELECT action,previous_digest,resulting_digest,operator_actor_id,grant_id,agent_id,task_id,session_id FROM memory_mutation_audit WHERE memory_id=$1 ORDER BY created_at',
        [created.recordId],
      );
      expect(audit.rows).toHaveLength(2);
      const approved = audit.rows.find((row) => row.action === 'APPROVE_MEMORY_PROPOSAL');
      expect(approved).toMatchObject({
        previous_digest: grant.fingerprint.slice(7),
        operator_actor_id: 'local-operator',
        grant_id: grant.grantId,
        agent_id: agentId,
        task_id: taskId,
        session_id: sessionId,
      });
      expect(approved?.resulting_digest).toMatch(/^[0-9a-f]{64}$/);
      expect((await query.list(ctx, { repository })).items.map((x) => x.record.id)).toContain(
        created.recordId,
      );
      await expect(approve(grant)).rejects.toMatchObject({ status: 403 });
      const persisted = await pool.query(
        'SELECT count(*)::int AS n FROM memory_mutation_audit WHERE memory_id=$1 AND action=$2',
        [created.recordId, 'APPROVE_MEMORY_PROPOSAL'],
      );
      expect(persisted.rows[0]?.n).toBe(1);
    });

    it('two independent parallel operator grants to same revision result in 1 success and 1 conflict', async () => {
      const created = await create(randomUUID());
      const [grantA, grantB] = await Promise.all([
        prepare(created.recordId),
        prepare(created.recordId),
      ]);
      const answers = await Promise.allSettled([approve(grantA), approve(grantB)]);
      expect(answers.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failed = answers.filter((result) => result.status === 'rejected');
      expect(failed).toHaveLength(1);
      if (failed[0]?.status === 'rejected') expect(failed[0].reason).toMatchObject({ status: 409 });
      const audit = await pool.query(
        'SELECT count(*)::int AS n FROM memory_mutation_audit WHERE memory_id=$1 AND action=$2',
        [created.recordId, 'APPROVE_MEMORY_PROPOSAL'],
      );
      expect(audit.rows[0]?.n).toBe(1);
      const history = await pool.query(
        'SELECT count(*)::int AS n FROM memory_revisions WHERE memory_id=$1',
        [created.recordId],
      );
      expect(history.rows[0]?.n).toBe(2);
    });

    it('wrong grant fingerprint consumes capability without touching DB; subsequent retry is denied', async () => {
      const created = await create(randomUUID());
      const grant = await prepare(created.recordId);
      await expect(
        approvals.approve(secret, grant.grantToken, created.recordId, {
          repository,
          expectedRevision: 1,
          fingerprint: 'sha256:' + 'f'.repeat(64),
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(approve(grant)).rejects.toMatchObject({ status: 403 });
      const r = await pool.query('SELECT status,revision FROM memory_records WHERE id=$1', [
        created.recordId,
      ]);
      expect(r.rows[0]).toMatchObject({ status: 'PROPOSED', revision: 1 });
      const fresh = await prepare(created.recordId);
      auth.revokeOperatorGrant(secret, fresh.grantId);
      await expect(approve(fresh)).rejects.toMatchObject({ status: 403 });
    });

    it('failed approval audit insert rolls back both status and immutable revision; grant cannot retry', async () => {
      const created = await create(randomUUID());
      const grant = await prepare(created.recordId);
      const failing = new MemoryApprovalService(
        auth,
        env,
        (url) => {
          const inner = new pg.Pool({ connectionString: url, ssl: false, max: 1 });
          return {
            connect: async () => {
              const client = await inner.connect();
              return {
                query: async (sql: string, params?: unknown[]) => {
                  if (sql.includes('INSERT INTO memory_mutation_audit'))
                    throw Error('private intentional DB failure');
                  return client.query(sql, params);
                },
                release: () => client.release(),
              };
            },
            end: async () => inner.end(),
          } as unknown as pg.Pool;
        },
        'test',
      );
      await expect(
        failing.approve(secret, grant.grantToken, created.recordId, {
          repository,
          expectedRevision: 1,
          fingerprint: grant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 503 });
      const state = await pool.query('SELECT status,revision FROM memory_records WHERE id=$1', [
        created.recordId,
      ]);
      expect(state.rows[0]).toMatchObject({ status: 'PROPOSED', revision: 1 });
      const revision = await pool.query(
        'SELECT count(*)::int AS n FROM memory_revisions WHERE memory_id=$1',
        [created.recordId],
      );
      expect(revision.rows[0]?.n).toBe(1);
      await expect(approve(grant)).rejects.toMatchObject({ status: 403 });
    });

    it('rejects a sourced PROPOSED proposal with immutable revision and durable operator audit, invisible to reads', async () => {
      const created = await create(randomUUID());
      const grant = await approvals.reviewRejectionAndGrant(secret, {
        repository,
        recordId: created.recordId,
        expectedRevision: 1,
      });
      expect(grant.action).toBe('REJECT_MEMORY_PROPOSAL');
      expect(grant.preview).toMatchObject({
        text: created.payload.text,
        sourceRef: created.payload.sourceRef,
      });
      const result = await approvals.reject(secret, grant.grantToken, created.recordId, {
        repository,
        expectedRevision: 1,
        fingerprint: grant.fingerprint,
      });
      expect(result).toEqual({ recordId: created.recordId, status: 'REVOKED', revision: 2 });
      const record = await pool.query(
        'SELECT status,revision,verified_by,verified_at,text,agent_id,session_id FROM memory_records WHERE id=$1',
        [created.recordId],
      );
      expect(record.rows[0]).toMatchObject({
        status: 'REVOKED',
        revision: 2,
        verified_by: null,
        verified_at: null,
        text: created.payload.text,
        agent_id: agentId,
        session_id: sessionId,
      });
      const revisions = await pool.query(
        'SELECT revision,status,text,source_id,changed_by FROM memory_revisions WHERE memory_id=$1 ORDER BY revision',
        [created.recordId],
      );
      expect(revisions.rows).toHaveLength(2);
      expect(revisions.rows.map((x) => x.status)).toEqual(['PROPOSED', 'REVOKED']);
      expect(revisions.rows[0].source_id).toBe(revisions.rows[1].source_id);
      expect(revisions.rows[1]).toMatchObject({
        revision: 2,
        changed_by: 'local-operator',
        text: created.payload.text,
      });
      const audit = await pool.query(
        'SELECT action,operator_actor_id,grant_id,previous_digest,resulting_digest,agent_id,task_id,session_id FROM memory_mutation_audit WHERE memory_id=$1',
        [created.recordId],
      );
      expect(audit.rows).toHaveLength(2);
      expect(audit.rows.find((x) => x.action === 'REJECT_MEMORY_PROPOSAL')).toMatchObject({
        operator_actor_id: 'local-operator',
        grant_id: grant.grantId,
        previous_digest: grant.fingerprint.slice(7),
        agent_id: agentId,
        task_id: taskId,
        session_id: sessionId,
      });
      expect(
        audit.rows.find((x) => x.action === 'REJECT_MEMORY_PROPOSAL')?.resulting_digest,
      ).toMatch(/^[0-9a-f]{64}$/);
      const ctx = { repository, agentId, taskId, sessionId };
      const reader = new MemoryQueryService(pool, randomBytes(32));
      expect((await reader.list(ctx, { repository })).items.map((x) => x.record.id)).not.toContain(
        created.recordId,
      );
      await expect(
        approvals.reject(secret, grant.grantToken, created.recordId, {
          repository,
          expectedRevision: 1,
          fingerprint: grant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        pool.query(
          "UPDATE memory_records SET revision=revision+1,status='VERIFIED',verified_by='local-operator',verified_at=NOW(),updated_at=NOW() WHERE id=$1",
          [created.recordId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('competing approve and reject decisions on revision 1 return exactly one success and one 409', async () => {
      const created = await create(randomUUID());
      const [approveGrant, rejectGrant] = await Promise.all([
        prepare(created.recordId),
        approvals.reviewRejectionAndGrant(secret, {
          repository,
          recordId: created.recordId,
          expectedRevision: 1,
        }),
      ]);
      const results = await Promise.allSettled([
        approve(approveGrant),
        approvals.reject(secret, rejectGrant.grantToken, created.recordId, {
          repository,
          expectedRevision: 1,
          fingerprint: rejectGrant.fingerprint,
        }),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const losers = results.filter((x) => x.status === 'rejected');
      expect(losers).toHaveLength(1);
      if (losers[0]?.status === 'rejected') expect(losers[0].reason).toMatchObject({ status: 409 });
      const record = await pool.query('SELECT status,revision FROM memory_records WHERE id=$1', [
        created.recordId,
      ]);
      expect(['VERIFIED', 'REVOKED']).toContain(record.rows[0]?.status);
      expect(record.rows[0]?.revision).toBe(2);
      const history = await pool.query(
        'SELECT count(*)::int AS n FROM memory_revisions WHERE memory_id=$1',
        [created.recordId],
      );
      expect(history.rows[0]?.n).toBe(2);
      const audit = await pool.query(
        "SELECT action FROM memory_mutation_audit WHERE memory_id=$1 AND action IN ('APPROVE_MEMORY_PROPOSAL','REJECT_MEMORY_PROPOSAL')",
        [created.recordId],
      );
      expect(audit.rows).toHaveLength(1);
      await expect(
        approvals.reject(secret, rejectGrant.grantToken, created.recordId, {
          repository,
          expectedRevision: 1,
          fingerprint: rejectGrant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('rejects direct PROPOSED→REVOKED SQL without transaction-local operator action', async () => {
      const created = await create(randomUUID());
      await expect(
        pool.query(
          "UPDATE memory_records SET status='REVOKED',revision=revision+1,updated_at=NOW() WHERE id=$1",
          [created.recordId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      const state = await pool.query('SELECT status,revision FROM memory_records WHERE id=$1', [
        created.recordId,
      ]);
      expect(state.rows[0]).toMatchObject({ status: 'PROPOSED', revision: 1 });
    });

    it('reject decision audit failure rolls back state/revision and permanently consumes the grant', async () => {
      const created = await create(randomUUID());
      const grant = await approvals.reviewRejectionAndGrant(secret, {
        repository,
        recordId: created.recordId,
        expectedRevision: 1,
      });
      const failing = new MemoryApprovalService(
        auth,
        env,
        (url) => {
          const inner = new pg.Pool({ connectionString: url, ssl: false, max: 1 });
          return {
            connect: async () => {
              const client = await inner.connect();
              return {
                query: async (sql: string, params?: unknown[]) => {
                  if (sql.includes('INSERT INTO memory_mutation_audit'))
                    throw Error('private artificial audit failure');
                  return client.query(sql, params);
                },
                release: () => client.release(),
              };
            },
            end: async () => inner.end(),
          } as unknown as pg.Pool;
        },
        'test',
      );
      await expect(
        failing.reject(secret, grant.grantToken, created.recordId, {
          repository,
          expectedRevision: 1,
          fingerprint: grant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 503 });
      const rec = await pool.query('SELECT status,revision FROM memory_records WHERE id=$1', [
        created.recordId,
      ]);
      expect(rec.rows[0]).toMatchObject({ status: 'PROPOSED', revision: 1 });
      const hist = await pool.query(
        'SELECT count(*)::int AS n FROM memory_revisions WHERE memory_id=$1',
        [created.recordId],
      );
      expect(hist.rows[0]?.n).toBe(1);
      await expect(
        approvals.reject(secret, grant.grantToken, created.recordId, {
          repository,
          expectedRevision: 1,
          fingerprint: grant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 403 });
      const audit = await pool.query(
        "SELECT count(*)::int AS n FROM memory_mutation_audit WHERE memory_id=$1 AND action='REJECT_MEMORY_PROPOSAL'",
        [created.recordId],
      );
      expect(audit.rows[0]?.n).toBe(0);
    });

    it('revokes an audited VERIFIED revision 2 to terminal REVOKED revision 3 without losing provenance', async () => {
      const created = await create(randomUUID());
      const prior = await prepare(created.recordId);
      await approve(prior);
      const ctx = { repository, agentId, taskId, sessionId };
      const reader = new MemoryQueryService(pool, randomBytes(32));
      expect((await reader.list(ctx, { repository })).items.map((x) => x.record.id)).toContain(
        created.recordId,
      );

      const review = await approvals.reviewVerifiedRevocationAndGrant(secret, {
        repository,
        recordId: created.recordId,
        expectedRevision: 2,
      });
      expect(review).toMatchObject({
        action: 'REVOKE_MEMORY_RECORD',
        expectedRevision: 2,
        preview: { text: created.payload.text, sourceRef: created.payload.sourceRef },
      });
      const result = await approvals.revokeVerified(secret, review.grantToken, created.recordId, {
        repository,
        expectedRevision: 2,
        fingerprint: review.fingerprint,
      });
      expect(result).toEqual({ recordId: created.recordId, status: 'REVOKED', revision: 3 });
      const current = await pool.query(
        'SELECT status,revision,verified_by,verified_at,agent_id,session_id,text FROM memory_records WHERE id=$1',
        [created.recordId],
      );
      expect(current.rows[0]).toMatchObject({
        status: 'REVOKED',
        revision: 3,
        verified_by: 'local-operator',
        agent_id: agentId,
        session_id: sessionId,
        text: created.payload.text,
      });
      expect(current.rows[0].verified_at).toBeInstanceOf(Date);
      const history = await pool.query(
        'SELECT revision,status,source_id,text,changed_by FROM memory_revisions WHERE memory_id=$1 ORDER BY revision',
        [created.recordId],
      );
      expect(history.rows.map((x) => x.status)).toEqual(['PROPOSED', 'VERIFIED', 'REVOKED']);
      expect(new Set(history.rows.map((x) => x.source_id)).size).toBe(1);
      expect(history.rows[2]).toMatchObject({
        revision: 3,
        text: created.payload.text,
        changed_by: 'local-operator',
      });
      const audit = await pool.query(
        'SELECT action,operator_actor_id,grant_id,previous_digest,resulting_digest FROM memory_mutation_audit WHERE memory_id=$1',
        [created.recordId],
      );
      expect(audit.rows).toHaveLength(3);
      expect(audit.rows.find((x) => x.action === 'REVOKE_MEMORY_RECORD')).toMatchObject({
        operator_actor_id: 'local-operator',
        grant_id: review.grantId,
        previous_digest: review.fingerprint.slice(7),
      });
      expect(audit.rows.find((x) => x.action === 'REVOKE_MEMORY_RECORD')?.resulting_digest).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect((await reader.list(ctx, { repository })).items.map((x) => x.record.id)).not.toContain(
        created.recordId,
      );
      await expect(reader.get(ctx, repository, created.recordId)).rejects.toThrow();
      await expect(
        approvals.revokeVerified(secret, review.grantToken, created.recordId, {
          repository,
          expectedRevision: 2,
          fingerprint: review.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        approvals.reviewVerifiedRevocationAndGrant(secret, {
          repository,
          recordId: created.recordId,
          expectedRevision: 2,
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('serializes two independent verified revocations: one success and one stale 409', async () => {
      const created = await create(randomUUID());
      await approve(await prepare(created.recordId));
      const [a, b] = await Promise.all([
        approvals.reviewVerifiedRevocationAndGrant(secret, {
          repository,
          recordId: created.recordId,
          expectedRevision: 2,
        }),
        approvals.reviewVerifiedRevocationAndGrant(secret, {
          repository,
          recordId: created.recordId,
          expectedRevision: 2,
        }),
      ]);
      const results = await Promise.allSettled(
        [a, b].map((g) =>
          approvals.revokeVerified(secret, g.grantToken, created.recordId, {
            repository,
            expectedRevision: 2,
            fingerprint: g.fingerprint,
          }),
        ),
      );
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const losers = results.filter((x) => x.status === 'rejected');
      expect(losers).toHaveLength(1);
      if (losers[0]?.status === 'rejected') expect(losers[0].reason).toMatchObject({ status: 409 });
      const rows = await pool.query('SELECT status,revision FROM memory_records WHERE id=$1', [
        created.recordId,
      ]);
      expect(rows.rows[0]).toMatchObject({ status: 'REVOKED', revision: 3 });
      const history = await pool.query(
        'SELECT count(*)::int AS n FROM memory_revisions WHERE memory_id=$1',
        [created.recordId],
      );
      expect(history.rows[0]?.n).toBe(3);
      const audits = await pool.query(
        "SELECT count(*)::int AS n FROM memory_mutation_audit WHERE memory_id=$1 AND action='REVOKE_MEMORY_RECORD'",
        [created.recordId],
      );
      expect(audits.rows[0]?.n).toBe(1);
    });

    it('refuses direct verified revocation and rolls back state/history on audited-write failure', async () => {
      const created = await create(randomUUID());
      await approve(await prepare(created.recordId));
      await expect(
        pool.query(
          "UPDATE memory_records SET status='REVOKED',revision=revision+1,updated_at=NOW() WHERE id=$1",
          [created.recordId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          "UPDATE memory_records SET status='SUPERSEDED',revision=revision+1,updated_at=NOW() WHERE id=$1",
          [created.recordId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      const grant = await approvals.reviewVerifiedRevocationAndGrant(secret, {
        repository,
        recordId: created.recordId,
        expectedRevision: 2,
      });
      const failing = new MemoryApprovalService(
        auth,
        env,
        (url) => {
          const inner = new pg.Pool({ connectionString: url, ssl: false, max: 1 });
          return {
            connect: async () => {
              const client = await inner.connect();
              return {
                query: async (sql: string, params?: unknown[]) => {
                  if (sql.includes('INSERT INTO memory_mutation_audit'))
                    throw Error('private simulated audit failure');
                  return client.query(sql, params);
                },
                release: () => client.release(),
              };
            },
            end: async () => inner.end(),
          } as unknown as pg.Pool;
        },
        'test',
      );
      await expect(
        failing.revokeVerified(secret, grant.grantToken, created.recordId, {
          repository,
          expectedRevision: 2,
          fingerprint: grant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 503 });
      const state = await pool.query('SELECT status,revision FROM memory_records WHERE id=$1', [
        created.recordId,
      ]);
      expect(state.rows[0]).toMatchObject({ status: 'VERIFIED', revision: 2 });
      const history = await pool.query(
        'SELECT count(*)::int AS n FROM memory_revisions WHERE memory_id=$1',
        [created.recordId],
      );
      expect(history.rows[0]?.n).toBe(2);
      const audit = await pool.query(
        "SELECT count(*)::int AS n FROM memory_mutation_audit WHERE memory_id=$1 AND action='REVOKE_MEMORY_RECORD'",
        [created.recordId],
      );
      expect(audit.rows[0]?.n).toBe(0);
      await expect(
        approvals.revokeVerified(secret, grant.grantToken, created.recordId, {
          repository,
          expectedRevision: 2,
          fingerprint: grant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('supersedes one independently approved same-scope memory using a linked immutable revision and audit', async () => {
      const first = await create('old-' + randomUUID());
      const next = await create('new-' + randomUUID());
      await approve(await prepare(first.recordId));
      await approve(await prepare(next.recordId));
      const service = new MemorySupersedeService(auth, env, undefined, 'test');
      const grant = await service.reviewAndGrant(secret, {
        repository,
        recordId: first.recordId,
        replacementRecordId: next.recordId,
        expectedRevision: 2,
      });
      expect(grant).toMatchObject({
        action: 'SUPERSEDE_MEMORY_RECORD',
        preview: {
          original: { text: first.payload.text, sourceRef: first.payload.sourceRef },
          replacement: { text: next.payload.text, sourceRef: next.payload.sourceRef },
        },
      });
      expect(grant.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      const result = await service.supersede(secret, grant.grantToken, first.recordId, {
        repository,
        expectedRevision: 2,
        replacementRecordId: next.recordId,
        fingerprint: grant.fingerprint,
      });
      expect(result).toEqual({
        recordId: first.recordId,
        status: 'SUPERSEDED',
        revision: 3,
        supersededById: next.recordId,
      });
      const rows = await pool.query(
        'SELECT id,status,revision,superseded_by_id,text FROM memory_records WHERE id=ANY($1::uuid[]) ORDER BY id',
        [[first.recordId, next.recordId]],
      );
      const old = rows.rows.find((r) => r.id === first.recordId);
      const newer = rows.rows.find((r) => r.id === next.recordId);
      expect(old).toMatchObject({
        status: 'SUPERSEDED',
        revision: 3,
        superseded_by_id: next.recordId,
        text: first.payload.text,
      });
      expect(newer).toMatchObject({
        status: 'VERIFIED',
        revision: 2,
        superseded_by_id: null,
        text: next.payload.text,
      });
      const revisions = await pool.query(
        'SELECT revision,status,source_id,text,changed_by FROM memory_revisions WHERE memory_id=$1 ORDER BY revision',
        [first.recordId],
      );
      expect(revisions.rows.map((r) => r.status)).toEqual(['PROPOSED', 'VERIFIED', 'SUPERSEDED']);
      expect(new Set(revisions.rows.map((r) => r.source_id)).size).toBe(1);
      expect(revisions.rows[2]).toMatchObject({
        text: first.payload.text,
        changed_by: 'local-operator',
      });
      const audits = await pool.query(
        'SELECT action,grant_id,operator_actor_id,previous_digest,resulting_digest FROM memory_mutation_audit WHERE memory_id=$1',
        [first.recordId],
      );
      expect(audits.rows).toHaveLength(3);
      const superseded = audits.rows.find((r) => r.action === 'SUPERSEDE_MEMORY_RECORD');
      expect(superseded).toMatchObject({
        grant_id: grant.grantId,
        operator_actor_id: 'local-operator',
        previous_digest: grant.fingerprint.slice(7),
      });
      expect(superseded?.resulting_digest).toMatch(/^[0-9a-f]{64}$/);
      const reader = new MemoryQueryService(pool, randomBytes(32));
      const visible = (
        await reader.list({ repository, agentId, taskId, sessionId }, { repository })
      ).items.map((x) => x.record.id);
      expect(visible).not.toContain(first.recordId);
      expect(visible).toContain(next.recordId);
      await expect(
        service.supersede(secret, grant.grantToken, first.recordId, {
          repository,
          expectedRevision: 2,
          replacementRecordId: next.recordId,
          fingerprint: grant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.reviewAndGrant(secret, {
          repository,
          recordId: first.recordId,
          replacementRecordId: next.recordId,
          expectedRevision: 2,
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('enforces one predecessor for a replacement under concurrent supersede CAS', async () => {
      const oldA = await create('predecessor-A-' + randomUUID());
      const oldB = await create('predecessor-B-' + randomUUID());
      const successor = await create('successor-' + randomUUID());
      await Promise.all(
        [oldA, oldB, successor].map(async (r) => approve(await prepare(r.recordId))),
      );
      const service = new MemorySupersedeService(auth, env, undefined, 'test');
      const [grantA, grantB] = await Promise.all(
        [oldA, oldB].map((r) =>
          service.reviewAndGrant(secret, {
            repository,
            recordId: r.recordId,
            replacementRecordId: successor.recordId,
            expectedRevision: 2,
          }),
        ),
      );
      const responses = await Promise.allSettled([
        service.supersede(secret, grantA.grantToken, oldA.recordId, {
          repository,
          expectedRevision: 2,
          replacementRecordId: successor.recordId,
          fingerprint: grantA.fingerprint,
        }),
        service.supersede(secret, grantB.grantToken, oldB.recordId, {
          repository,
          expectedRevision: 2,
          replacementRecordId: successor.recordId,
          fingerprint: grantB.fingerprint,
        }),
      ]);
      expect(responses.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const failures = responses.filter((x) => x.status === 'rejected');
      expect(failures).toHaveLength(1);
      if (failures[0]?.status === 'rejected')
        expect(failures[0].reason).toMatchObject({ status: 409 });
      const links = await pool.query(
        'SELECT id FROM memory_records WHERE repository=$1 AND superseded_by_id=$2',
        [repository, successor.recordId],
      );
      expect(links.rows).toHaveLength(1);
      const audit = await pool.query(
        "SELECT count(*)::int AS n FROM memory_mutation_audit WHERE action='SUPERSEDE_MEMORY_RECORD' AND memory_id=ANY($1::uuid[])",
        [[oldA.recordId, oldB.recordId]],
      );
      expect(audit.rows[0]?.n).toBe(1);
    });

    it('denies foreign kind, self target, wrong action replay and direct unaudited supersede', async () => {
      const first = await create('original-' + randomUUID());
      const next = await create('target-' + randomUUID());
      await approve(await prepare(first.recordId));
      await approve(await prepare(next.recordId));
      const service = new MemorySupersedeService(auth, env, undefined, 'test');
      await expect(
        service.reviewAndGrant(secret, {
          repository,
          recordId: first.recordId,
          replacementRecordId: first.recordId,
          expectedRevision: 2,
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        pool.query(
          "UPDATE memory_records SET status='SUPERSEDED',superseded_by_id=$2::uuid,revision=revision+1,updated_at=NOW() WHERE id=$1",
          [first.recordId, next.recordId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      const wrongGrant = await approvals.reviewVerifiedRevocationAndGrant(secret, {
        repository,
        recordId: first.recordId,
        expectedRevision: 2,
      });
      await expect(
        service.supersede(secret, wrongGrant.grantToken, first.recordId, {
          repository,
          expectedRevision: 2,
          replacementRecordId: next.recordId,
          fingerprint: wrongGrant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        approvals.revokeVerified(secret, wrongGrant.grantToken, first.recordId, {
          repository,
          expectedRevision: 2,
          fingerprint: wrongGrant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 403 });
      const different = await proposer.propose(request(bearer), randomUUID(), {
        kind: 'fact',
        text: 'Different kind ' + randomUUID(),
        sourceRef: 'agent-session:' + sessionId,
      });
      await approve(await prepare(different.recordId));
      await expect(
        service.reviewAndGrant(secret, {
          repository,
          recordId: first.recordId,
          replacementRecordId: different.recordId,
          expectedRevision: 2,
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('rolls back link, third revision and audit if supersede audit INSERT fails; burns one-use grant', async () => {
      const prior = await create('rollback-old-' + randomUUID());
      const successor = await create('rollback-next-' + randomUUID());
      await approve(await prepare(prior.recordId));
      await approve(await prepare(successor.recordId));
      const service = new MemorySupersedeService(auth, env, undefined, 'test');
      const grant = await service.reviewAndGrant(secret, {
        repository,
        recordId: prior.recordId,
        replacementRecordId: successor.recordId,
        expectedRevision: 2,
      });
      const failing = new MemorySupersedeService(
        auth,
        env,
        (url) => {
          const inner = new pg.Pool({ connectionString: url, ssl: false, max: 1 });
          return {
            connect: async () => {
              const client = await inner.connect();
              return {
                query: async (sql: string, params?: unknown[]) => {
                  if (sql.includes('INSERT INTO memory_mutation_audit'))
                    throw Error('private simulated audit failure');
                  return client.query(sql, params);
                },
                release: () => client.release(),
              };
            },
            end: async () => inner.end(),
          } as unknown as pg.Pool;
        },
        'test',
      );
      await expect(
        failing.supersede(secret, grant.grantToken, prior.recordId, {
          repository,
          expectedRevision: 2,
          replacementRecordId: successor.recordId,
          fingerprint: grant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 503 });
      const state = await pool.query(
        'SELECT status,revision,superseded_by_id FROM memory_records WHERE id=$1',
        [prior.recordId],
      );
      expect(state.rows[0]).toMatchObject({
        status: 'VERIFIED',
        revision: 2,
        superseded_by_id: null,
      });
      const history = await pool.query(
        'SELECT count(*)::int AS n FROM memory_revisions WHERE memory_id=$1',
        [prior.recordId],
      );
      expect(history.rows[0]?.n).toBe(2);
      const audit = await pool.query(
        "SELECT count(*)::int AS n FROM memory_mutation_audit WHERE action='SUPERSEDE_MEMORY_RECORD' AND memory_id=$1",
        [prior.recordId],
      );
      expect(audit.rows[0]?.n).toBe(0);
      await expect(
        service.supersede(secret, grant.grantToken, prior.recordId, {
          repository,
          expectedRevision: 2,
          replacementRecordId: successor.recordId,
          fingerprint: grant.fingerprint,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('rejects unsourced direct records and rejects reassignment of identity/scope/text', async () => {
      const ghost = randomUUID();
      await pool.query(
        `INSERT INTO memory_records(id,repository,scope,kind,status,text,revision,session_id,agent_id,updated_at)
         VALUES($1,$2,'SESSION','FACT','PROPOSED','unattributed not approvable',1,$3,$4,NOW())`,
        [ghost, repository, sessionId, agentId],
      );
      await expect(prepare(ghost)).rejects.toMatchObject({ status: 409 });
      const created = await create(randomUUID());
      const grant = await prepare(created.recordId);
      await approve(grant);
      for (const field of [
        "scope='PROJECT',session_id=NULL",
        'agent_id=NULL',
        "text='changed after review'",
        "kind='FACT'",
      ]) {
        await expect(
          pool.query(
            `UPDATE memory_records SET ${field},revision=revision+1,updated_at=NOW() WHERE id=$1`,
            [created.recordId],
          ),
        ).rejects.toMatchObject({ code: 'P0001' });
      }
      const state = await pool.query(
        'SELECT status,revision,text FROM memory_records WHERE id=$1',
        [created.recordId],
      );
      expect(state.rows[0]).toMatchObject({
        status: 'VERIFIED',
        revision: 2,
        text: created.payload.text,
      });
    });
  },
);
