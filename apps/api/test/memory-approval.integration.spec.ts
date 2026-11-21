import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveMemoryDatabaseConfiguration } from '../src/database/memory-database-policy.js';
import { MemoryApprovalService } from '../src/memory/memory-approval.service.js';
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
