import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { resolveMemoryDatabaseConfiguration } from '../src/database/memory-database-policy.js';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';
import { MemoryOperatorIdentityService } from '../src/security/memory-operator-identity.service.js';
import { MemoryPersonalRejectionService } from '../src/memory/memory-personal-rejection.service.js';
import { MemoryProposalService } from '../src/memory/memory-proposal.service.js';
import { MemoryApprovalService } from '../src/memory/memory-approval.service.js';
import { MemoryQueryService } from '../src/memory/memory-query.service.js';
import { randomBytes } from 'node:crypto';

const eligible =
  process.env.DEV_HUB_MEMORY_ENABLE === 'true' &&
  Boolean(process.env.DEV_HUB_MEMORY_TEST_DATABASE_URL);
const repo = 'sauron9521/gym-dev-hub';
const root = 'isolated-personal-rejection-bootstrap-secret-48bytes';
const agentId = randomUUID(),
  taskId = randomUUID(),
  sessionId = randomUUID(),
  fixture = randomUUID();
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_REJECTION_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_IDENTITIES_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_PERSONAL_REJECTION_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repo,
  DEV_HUB_MEMORY_OPERATOR_SECRET: root,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
};
type Grant = Awaited<ReturnType<MemoryPersonalRejectionService['reviewAndGrant']>>;
describe.skipIf(!eligible)(
  'personal operator rejection audited in isolated PostgreSQL only',
  () => {
    let pool: pg.Pool, authorization: MemoryAuthorizationService;
    let identities: MemoryOperatorIdentityService,
      personal: MemoryPersonalRejectionService,
      proposals: MemoryProposalService,
      old: MemoryApprovalService;
    let reviewer: { identityId: string; bearerToken: string },
      auditor: { identityId: string; bearerToken: string };
    let agentBearer: string;
    beforeAll(async () => {
      const config = resolveMemoryDatabaseConfiguration(process.env, 'test');
      if (!config.enabled || config.database !== 'gym_dev_hub_memory_test')
        throw Error('Refusing unguarded DB');
      env.DEV_HUB_MEMORY_TEST_DATABASE_URL = config.url;
      pool = new pg.Pool({
        connectionString: config.url,
        ssl: false,
        max: 5,
        connectionTimeoutMillis: 4000,
      });
      const found = await pool.query('SELECT current_database() AS db');
      if (found.rows[0]?.db !== 'gym_dev_hub_memory_test') throw Error('Wrong DB');
      await pool.query('INSERT INTO memory_repositories(name) VALUES($1) ON CONFLICT DO NOTHING', [
        repo,
      ]);
      await pool.query('INSERT INTO memory_tasks(id,repository,external_ref) VALUES($1,$2,$3)', [
        taskId,
        repo,
        'personal-task-' + fixture,
      ]);
      await pool.query(
        'INSERT INTO memory_agent_identities(id,repository,external_ref) VALUES($1,$2,$3)',
        [agentId, repo, 'personal-agent-' + fixture],
      );
      await pool.query(
        'INSERT INTO memory_sessions(id,repository,external_ref,task_id,agent_id) VALUES($1,$2,$3,$4,$5)',
        [sessionId, repo, 'personal-session-' + fixture, taskId, agentId],
      );
      authorization = new MemoryAuthorizationService(env);
      identities = new MemoryOperatorIdentityService(authorization, env, undefined, 'test');
      personal = new MemoryPersonalRejectionService(identities, env, undefined, 'test');
      proposals = new MemoryProposalService(authorization, env, undefined, 'test');
      old = new MemoryApprovalService(authorization, env, undefined, 'test');
      agentBearer = authorization.provisionReadCredential(root, {
        kind: 'agent',
        repository: repo,
        agentId,
        taskId,
        sessionId,
        ttlSeconds: 900,
        permission: 'PROPOSE_MEMORY',
      }).bearerToken;
      reviewer = await identities.issue(root, {
        repository: repo,
        handle: 'review_' + fixture.slice(0, 12),
        role: 'REVIEWER',
        ttlSeconds: 3600,
      });
      auditor = await identities.issue(root, {
        repository: repo,
        handle: 'audit_' + fixture.slice(0, 12),
        role: 'AUDITOR',
        ttlSeconds: 3600,
      });
    });
    afterAll(async () => {
      if (pool) await pool.end();
    });
    async function propose() {
      return proposals.propose(
        {
          method: 'POST',
          host: '127.0.0.1:3101',
          remoteAddress: '127.0.0.1',
          origin: 'http://127.0.0.1:3100',
          fetchSite: 'same-origin',
          path: '/v1/memory/proposals',
          authorization: 'Bearer ' + agentBearer,
        },
        randomUUID(),
        {
          kind: 'decision',
          text: 'Untrusted private decision ' + randomUUID(),
          sourceRef: 'agent-session:' + sessionId,
        },
      );
    }
    const review = (bearer: string, recordId: string) =>
      personal.reviewAndGrant(bearer, {
        repository: repo,
        recordId,
        expectedRevision: 1,
      });
    const reject = (bearer: string, grant: Grant, recordId = grant.recordId) =>
      personal.reject(bearer, grant.grantToken, recordId, {
        repository: repo,
        expectedRevision: 1,
        fingerprint: grant.fingerprint,
      });

    it('persists personal UUID and immutable revisions, hides rejected knowledge', async () => {
      const item = await propose();
      const grant = await review(reviewer.bearerToken, item.recordId);
      expect(grant).toMatchObject({
        action: 'REJECT_MEMORY_PROPOSAL',
        operatorIdentityId: reviewer.identityId,
        recordId: item.recordId,
        expectedRevision: 1,
      });
      expect(grant.preview.sourceRef).toBe('agent-session:' + sessionId);
      expect(await reject(reviewer.bearerToken, grant)).toEqual({
        recordId: item.recordId,
        status: 'REVOKED',
        revision: 2,
      });
      const record = await pool.query('SELECT status,revision FROM memory_records WHERE id=$1', [
        item.recordId,
      ]);
      expect(record.rows[0]).toMatchObject({ status: 'REVOKED', revision: 2 });
      const history = await pool.query(
        'SELECT revision,status,changed_by,source_id FROM memory_revisions WHERE memory_id=$1 ORDER BY revision',
        [item.recordId],
      );
      expect(history.rows).toHaveLength(2);
      expect(history.rows.map((x) => x.status)).toEqual(['PROPOSED', 'REVOKED']);
      expect(history.rows[1].changed_by).toBe('operator:' + reviewer.identityId);
      expect(history.rows[0].source_id).toBe(history.rows[1].source_id);
      const audit = await pool.query(
        "SELECT action,operator_actor_id,operator_identity_id,grant_id,previous_digest,resulting_digest FROM memory_mutation_audit WHERE memory_id=$1 AND action='REJECT_MEMORY_PROPOSAL'",
        [item.recordId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        action: 'REJECT_MEMORY_PROPOSAL',
        operator_actor_id: 'operator:' + reviewer.identityId,
        operator_identity_id: reviewer.identityId,
        grant_id: grant.grantId,
        previous_digest: grant.fingerprint.slice(7),
      });
      expect(audit.rows[0].resulting_digest).toMatch(/^[0-9a-f]{64}$/);
      const reader = new MemoryQueryService(pool, randomBytes(32));
      expect(
        (
          await reader.list({ repository: repo, agentId, taskId, sessionId }, { repository: repo })
        ).items.map((x) => x.record.id),
      ).not.toContain(item.recordId);
      await expect(reject(reviewer.bearerToken, grant)).rejects.toMatchObject({ status: 403 });
      await expect(review(reviewer.bearerToken, item.recordId)).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        old.reviewRejectionAndGrant(root, {
          repository: repo,
          recordId: item.recordId,
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ status: 503 });
    });

    it('AUDITOR cannot reject, foreign bearer cannot consume review, invalid actor never claimed', async () => {
      const item = await propose();
      await expect(review(auditor.bearerToken, item.recordId)).rejects.toMatchObject({
        status: 403,
      });
      await expect(review(root, item.recordId)).rejects.toMatchObject({ status: 401 });
      const grant = await review(reviewer.bearerToken, item.recordId);
      await expect(reject(auditor.bearerToken, grant)).rejects.toMatchObject({ status: 403 });
      await expect(reject(reviewer.bearerToken, grant)).rejects.toMatchObject({ status: 403 });
      const state = await pool.query('SELECT status,revision FROM memory_records WHERE id=$1', [
        item.recordId,
      ]);
      expect(state.rows[0]).toMatchObject({ status: 'PROPOSED', revision: 1 });
    });

    it('revoked reviewer token cannot commit a prior grant; no stored personal audit', async () => {
      const temporary = await identities.issue(root, {
        repository: repo,
        handle: 'temp_' + randomUUID().slice(0, 12),
        role: 'REVIEWER',
        ttlSeconds: 3600,
      });
      const item = await propose();
      const grant = await review(temporary.bearerToken, item.recordId);
      expect(
        (await identities.revoke(root, temporary.identityId, { repository: repo })).revoked,
      ).toBe(true);
      await expect(reject(temporary.bearerToken, grant)).rejects.toMatchObject({ status: 403 });
      const state = await pool.query('SELECT status,revision FROM memory_records WHERE id=$1', [
        item.recordId,
      ]);
      expect(state.rows[0]).toMatchObject({ status: 'PROPOSED', revision: 1 });
      const audit = await pool.query(
        "SELECT id FROM memory_mutation_audit WHERE memory_id=$1 AND action='REJECT_MEMORY_PROPOSAL'",
        [item.recordId],
      );
      expect(audit.rows).toHaveLength(0);
    });

    it('two distinct grants concurrently reject only once (CAS + one durable actor audit)', async () => {
      const item = await propose();
      const [a, b] = await Promise.all([
        review(reviewer.bearerToken, item.recordId),
        review(reviewer.bearerToken, item.recordId),
      ]);
      const outcomes = await Promise.allSettled([
        reject(reviewer.bearerToken, a),
        reject(reviewer.bearerToken, b),
      ]);
      expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const failed = outcomes.filter((x) => x.status === 'rejected');
      expect(failed).toHaveLength(1);
      if (failed[0]?.status === 'rejected') expect(failed[0].reason).toMatchObject({ status: 409 });
      const changes = await pool.query(
        "SELECT count(*)::int AS n FROM memory_mutation_audit WHERE memory_id=$1 AND action='REJECT_MEMORY_PROPOSAL'",
        [item.recordId],
      );
      expect(changes.rows[0].n).toBe(1);
      const history = await pool.query(
        'SELECT count(*)::int AS n FROM memory_revisions WHERE memory_id=$1',
        [item.recordId],
      );
      expect(history.rows[0].n).toBe(2);
    });

    it('audit failure rolls back status/history; consumed grant remains permanently unusable', async () => {
      const broken = new MemoryPersonalRejectionService(
        identities,
        env,
        (url) => {
          const inner = new pg.Pool({ connectionString: url, ssl: false, max: 1 });
          return {
            query: (...args: Parameters<pg.Pool['query']>) => inner.query(...args),
            connect: async () => {
              const client = await inner.connect();
              return {
                query: async (sql: string, params?: unknown[]) => {
                  if (sql.includes('INSERT INTO memory_mutation_audit'))
                    throw Error('simulated private DB audit outage');
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
      const item = await propose();
      const grant = await broken.reviewAndGrant(reviewer.bearerToken, {
        repository: repo,
        recordId: item.recordId,
        expectedRevision: 1,
      });
      const attempt = () =>
        broken.reject(reviewer.bearerToken, grant.grantToken, item.recordId, {
          repository: repo,
          expectedRevision: 1,
          fingerprint: grant.fingerprint,
        });
      await expect(attempt()).rejects.toMatchObject({ status: 503 });
      const record = await pool.query('SELECT status,revision FROM memory_records WHERE id=$1', [
        item.recordId,
      ]);
      expect(record.rows[0]).toMatchObject({ status: 'PROPOSED', revision: 1 });
      const history = await pool.query(
        'SELECT count(*)::int AS n FROM memory_revisions WHERE memory_id=$1',
        [item.recordId],
      );
      expect(history.rows[0].n).toBe(1);
      await expect(attempt()).rejects.toMatchObject({ status: 403 });
    });
  },
);
