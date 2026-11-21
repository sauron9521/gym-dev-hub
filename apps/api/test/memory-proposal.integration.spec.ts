import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveMemoryDatabaseConfiguration } from '../src/database/memory-database-policy.js';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';
import { MemoryProposalService } from '../src/memory/memory-proposal.service.js';
import { MemoryQueryService } from '../src/memory/memory-query.service.js';

const enabled =
  process.env.DEV_HUB_MEMORY_ENABLE === 'true' &&
  Boolean(process.env.DEV_HUB_MEMORY_TEST_DATABASE_URL);
const repository = 'sauron9521/gym-dev-hub';
const operatorSecret = 'isolated-proposal-test-operator-secret-at-least-32';
const taskId = randomUUID();
const agentId = randomUUID();
const sessionId = randomUUID();
const fixture = randomUUID();
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_SECRET: operatorSecret,
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repository,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
};
const request = (token: string) => ({
  method: 'POST',
  host: '127.0.0.1:3101',
  remoteAddress: '127.0.0.1',
  origin: 'http://127.0.0.1:3100',
  fetchSite: 'same-origin',
  path: '/v1/memory/proposals',
  authorization: 'Bearer ' + token,
});
const content = (marker: string) => ({
  kind: 'decision' as const,
  text: 'Untrusted agent proposal ' + marker,
  sourceRef: 'agent-session:' + sessionId,
});

describe.skipIf(!enabled)(
  'real isolated PostgreSQL proposal intake, atomic audit and idempotency',
  () => {
    let pool: pg.Pool;
    let auth: MemoryAuthorizationService;
    let service: MemoryProposalService;
    let bearer: string;

    beforeAll(async () => {
      const config = resolveMemoryDatabaseConfiguration(process.env, 'test');
      if (!config.enabled || config.database !== 'gym_dev_hub_memory_test')
        throw Error('proposal integration refused non-test DB');
      env.DEV_HUB_MEMORY_TEST_DATABASE_URL = config.url;
      pool = new pg.Pool({ connectionString: config.url, ssl: false, max: 3 });
      const check = await pool.query('SELECT current_database() AS db');
      if (check.rows[0]?.db !== 'gym_dev_hub_memory_test')
        throw Error('never test against dev or Gym Platform DB');
      await pool.query('INSERT INTO memory_repositories(name) VALUES ($1) ON CONFLICT DO NOTHING', [
        repository,
      ]);
      await pool.query('INSERT INTO memory_tasks(id,repository,external_ref) VALUES ($1,$2,$3)', [
        taskId,
        repository,
        'proposal-task-' + fixture,
      ]);
      await pool.query(
        'INSERT INTO memory_agent_identities(id,repository,external_ref) VALUES ($1,$2,$3)',
        [agentId, repository, 'proposal-agent-' + fixture],
      );
      await pool.query(
        'INSERT INTO memory_sessions(id,repository,external_ref,task_id,agent_id) VALUES ($1,$2,$3,$4,$5)',
        [sessionId, repository, 'proposal-session-' + fixture, taskId, agentId],
      );
      auth = new MemoryAuthorizationService(env);
      bearer = auth.provisionReadCredential(operatorSecret, {
        kind: 'agent',
        repository,
        agentId,
        taskId,
        sessionId,
        ttlSeconds: 300,
        permission: 'PROPOSE_MEMORY',
      }).bearerToken;
      service = new MemoryProposalService(auth, env, undefined, 'test');
    });
    afterAll(async () => {
      if (pool) await pool.end();
    });

    it('persists only PROPOSED, immutable same-repo AGENT provenance, source-linked revision and metadata audit', async () => {
      const marker = randomUUID();
      const key = randomUUID();
      const receipt = await service.propose(request(bearer), key, content(marker));
      expect(receipt).toMatchObject({ status: 'PROPOSED', revision: 1, replayed: false });
      const rows = await pool.query(
        `SELECT r.status,r.scope,r.kind,r.task_id,r.session_id,r.agent_id,r.verified_by,
        s.source_type,s.actor_id,s.source_ref,
        v.source_id,v.changed_by,v.status AS revision_status,
        a.action,a.previous_digest,a.resulting_digest,a.agent_id AS audited_agent
        FROM memory_records r
        JOIN memory_sources s ON (s.repository=r.repository AND s.memory_id=r.id)
        JOIN memory_revisions v ON (v.repository=r.repository AND v.memory_id=r.id)
        JOIN memory_mutation_audit a ON (a.repository=r.repository AND a.memory_id=r.id)
        WHERE r.repository=$1 AND r.id=$2`,
        [repository, receipt.recordId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        status: 'PROPOSED',
        scope: 'SESSION',
        kind: 'DECISION',
        task_id: null,
        session_id: sessionId,
        agent_id: agentId,
        verified_by: null,
        source_type: 'AGENT',
        actor_id: agentId,
        source_ref: 'agent-session:' + sessionId,
        changed_by: agentId,
        revision_status: 'PROPOSED',
        action: 'PROPOSE_MEMORY',
        previous_digest: null,
        audited_agent: agentId,
      });
      const source = await pool.query('SELECT id FROM memory_sources WHERE memory_id=$1', [
        receipt.recordId,
      ]);
      expect(rows.rows[0].source_id).toBe(source.rows[0].id);
      expect(rows.rows[0].resulting_digest).toMatch(/^[0-9a-f]{64}$/);
      const visible = await new MemoryQueryService(pool, randomBytes(32)).list(
        { repository, agentId, taskId, sessionId },
        { repository },
      );
      expect(visible.items.map((x) => x.record.id)).not.toContain(receipt.recordId);
      const replay = await service.propose(request(bearer), key, content(marker));
      expect(replay).toEqual({ ...receipt, replayed: true });
      const count = await pool.query(
        'SELECT count(*)::int AS n FROM memory_proposal_requests WHERE memory_id=$1',
        [receipt.recordId],
      );
      expect(count.rows[0]?.n).toBe(1);
      await expect(
        service.propose(request(bearer), key, content('different ' + marker)),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('serializes concurrent retries with one real committed record and no duplicate audit', async () => {
      const key = randomUUID();
      const payload = content('parallel-' + randomUUID());
      const answers = await Promise.all(
        Array.from({ length: 4 }, () => service.propose(request(bearer), key, payload)),
      );
      expect(new Set(answers.map((a) => a.recordId)).size).toBe(1);
      expect(answers.filter((a) => !a.replayed)).toHaveLength(1);
      const [recordId] = answers.map((a) => a.recordId);
      const r = await pool.query(
        'SELECT count(*)::int AS n FROM memory_mutation_audit WHERE memory_id=$1',
        [recordId],
      );
      expect(r.rows[0]?.n).toBe(1);
    });

    it('rolls back record, source, revision and idempotency when audit INSERT fails', async () => {
      const marker = 'rollback-' + randomUUID();
      const config = resolveMemoryDatabaseConfiguration(env, 'test');
      if (!config.enabled) throw Error('test config disabled');
      const failing = new MemoryProposalService(
        auth,
        env,
        (url) => {
          const innerPool = new pg.Pool({ connectionString: url, ssl: false, max: 1 });
          return {
            connect: async () => {
              const client = await innerPool.connect();
              return {
                query: async (sql: string, params?: unknown[]) => {
                  if (sql.includes('INSERT INTO memory_mutation_audit'))
                    throw Error('hidden forced DB failure');
                  return client.query(sql, params);
                },
                release: () => client.release(),
              };
            },
            end: async () => innerPool.end(),
          } as unknown as pg.Pool;
        },
        'test',
      );
      await expect(
        failing.propose(request(bearer), randomUUID(), content(marker)),
      ).rejects.toMatchObject({ status: 503 });
      const rows = await pool.query('SELECT count(*)::int AS n FROM memory_records WHERE text=$1', [
        content(marker).text,
      ]);
      expect(rows.rows[0]?.n).toBe(0);
    });

    it('fails closed for revoked/malformed bearer and missing/foreign session IDs', async () => {
      const payload = content('deny-' + randomUUID());
      const original = auth.provisionReadCredential(operatorSecret, {
        kind: 'agent',
        repository,
        agentId,
        taskId,
        sessionId,
        ttlSeconds: 60,
        permission: 'PROPOSE_MEMORY',
      });
      auth.revokeCredential(operatorSecret, original.credentialId);
      await expect(
        service.propose(request(original.bearerToken), randomUUID(), payload),
      ).rejects.toMatchObject({ status: 401 });
      const wrongSession = auth.provisionReadCredential(operatorSecret, {
        kind: 'agent',
        repository,
        agentId,
        taskId,
        sessionId: randomUUID(),
        ttlSeconds: 60,
        permission: 'PROPOSE_MEMORY',
      });
      await expect(
        service.propose(request(wrongSession.bearerToken), randomUUID(), payload),
      ).rejects.toMatchObject({ status: 403 });
      const readOnly = auth.provisionReadCredential(operatorSecret, {
        kind: 'agent',
        repository,
        agentId,
        taskId,
        sessionId,
        ttlSeconds: 60,
      });
      await expect(
        service.propose(request(readOnly.bearerToken), randomUUID(), payload),
      ).rejects.toMatchObject({ status: 403 });
    });
  },
);
