import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { resolveMemoryDatabaseConfiguration } from '../src/database/memory-database-policy.js';

// No DB at all in normal pnpm check; the separate memory CI job explicitly
// supplies a short-lived test-only database. Never connect to dev/production.
const enabled =
  process.env.DEV_HUB_MEMORY_ENABLE === 'true' && !!process.env.DEV_HUB_MEMORY_TEST_DATABASE_URL;
const REPO_A = 'sauron9521/gym-dev-hub';
const REPO_B = 'sauron9521/gym-platform';

describe.skipIf(!enabled)(
  'memory revision and tenant isolation (ephemeral PostgreSQL only)',
  () => {
    let pool: pg.Pool;
    let taskA: string;
    let taskB: string;
    let agentA: string;
    let sessionA: string;
    let recordA: string;
    const fixtureTag = randomUUID();
    beforeAll(async () => {
      const config = resolveMemoryDatabaseConfiguration(process.env, 'test');
      if (!config.enabled || config.database !== 'gym_dev_hub_memory_test')
        throw new Error('Refusing non-test DB');
      pool = new pg.Pool({
        connectionString: config.url,
        ssl: false,
        max: 3,
        connectionTimeoutMillis: 4000,
      });
      const db = await pool.query('SELECT current_database() AS db');
      if (db.rows[0].db !== 'gym_dev_hub_memory_test') throw new Error('Not isolated test DB');
      await pool.query(
        'INSERT INTO memory_repositories(name) VALUES ($1), ($2) ON CONFLICT DO NOTHING',
        [REPO_A, REPO_B],
      );
      taskA = randomUUID();
      taskB = randomUUID();
      agentA = randomUUID();
      sessionA = randomUUID();
      recordA = randomUUID();
      await pool.query(
        'INSERT INTO memory_tasks(id,repository,external_ref) VALUES ($1,$2,$3),($4,$5,$6)',
        [taskA, REPO_A, `issue-37-${fixtureTag}`, taskB, REPO_B, `issue-37-${fixtureTag}`],
      );
      await pool.query(
        'INSERT INTO memory_agent_identities(id,repository,external_ref) VALUES ($1,$2,$3)',
        [agentA, REPO_A, `agent-${fixtureTag}`],
      );
      await pool.query(
        'INSERT INTO memory_sessions(id,repository,external_ref,task_id,agent_id) VALUES ($1,$2,$3,$4,$5)',
        [sessionA, REPO_A, `session-${fixtureTag}`, taskA, agentA],
      );
      await pool.query(
        "INSERT INTO memory_records(id,repository,scope,kind,status,text,revision,task_id,updated_at) VALUES ($1,$2,'TASK','DECISION','PROPOSED','Initial proposed note',1,$3,NOW())",
        [recordA, REPO_A, taskA],
      );
    });
    afterAll(async () => {
      await pool?.end();
    });

    it('creates one immutable snapshot automatically on the initial insert', async () => {
      const r = await pool.query(
        'SELECT revision, status, text, changed_by FROM memory_revisions WHERE repository=$1 AND memory_id=$2',
        [REPO_A, recordA],
      );
      expect(r.rows).toEqual([
        {
          revision: 1,
          status: 'PROPOSED',
          text: 'Initial proposed note',
          changed_by: 'unattributed-db-write',
        },
      ]);
    });
    it('rejects cross-repository task/session/agent references through compound FKs', async () => {
      await expect(
        pool.query(
          'INSERT INTO memory_sessions(id,repository,external_ref,task_id) VALUES($1,$2,$3,$4)',
          [randomUUID(), REPO_A, `bad-${fixtureTag}`, taskB],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        pool.query(
          "INSERT INTO memory_records(id,repository,scope,kind,text,task_id,updated_at) VALUES($1,$2,'TASK','FACT','blocked',$3,NOW())",
          [randomUUID(), REPO_B, taskA],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        pool.query(
          "INSERT INTO memory_records(id,repository,scope,kind,text,session_id,updated_at) VALUES($1,$2,'SESSION','FACT','blocked',$3,NOW())",
          [randomUUID(), REPO_B, sessionA],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        pool.query(
          "INSERT INTO memory_records(id,repository,scope,kind,text,agent_id,updated_at) VALUES($1,$2,'PROJECT','FACT','blocked',$3,NOW())",
          [randomUUID(), REPO_B, agentA],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
    it('rejects attempts to move an existing referenced task into another repository', async () => {
      await expect(
        pool.query('UPDATE memory_tasks SET repository=$1,external_ref=$3 WHERE id=$2', [
          REPO_B,
          taskA,
          `relocation-${fixtureTag}`,
        ]),
      ).rejects.toMatchObject({ code: '23503' });
    });
    it('validates repository registration, scopes, unique external IDs and identity', async () => {
      await expect(
        pool.query('INSERT INTO memory_tasks(id,repository,external_ref) VALUES($1,$2,$3)', [
          randomUUID(),
          'unregistered/other',
          'no-allowlist',
        ]),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        pool.query('INSERT INTO memory_tasks(id,repository,external_ref) VALUES($1,$2,$3)', [
          randomUUID(),
          REPO_A,
          `issue-37-${fixtureTag}`,
        ]),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        pool.query(
          "INSERT INTO memory_records(id,repository,scope,kind,text,updated_at) VALUES($1,$2,'TASK','FACT','missing-task',NOW())",
          [randomUUID(), REPO_A],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        pool.query("INSERT INTO memory_repositories(name) VALUES('bad-repo')"),
      ).rejects.toMatchObject({ code: '23514' });
    });
    it('accepts in-repository provenance and rejects spoofing across repos', async () => {
      const sourceId = randomUUID();
      await pool.query(
        "INSERT INTO memory_sources(id,repository,memory_id,source_type,actor_id,source_ref,source_sha,observed_at) VALUES($1,$2,$3,'GITHUB','operator','PR #88',$4,NOW())",
        [sourceId, REPO_A, recordA, 'a'.repeat(40)],
      );
      await expect(
        pool.query(
          "INSERT INTO memory_sources(id,repository,memory_id,source_type,actor_id,source_ref,observed_at) VALUES($1,$2,$3,'HUMAN','operator','bad',NOW())",
          [randomUUID(), REPO_B, recordA],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        pool.query('UPDATE memory_sources SET source_ref=$1 WHERE id=$2', ['rewritten', sourceId]),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query('DELETE FROM memory_sources WHERE id=$1', [sourceId]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });
    it('ensures only one of two concurrent CAS writes advances the revision', async () => {
      const [a, b] = await Promise.all([
        pool.query(
          "UPDATE memory_records SET revision=revision+1,status='VERIFIED',verified_by='operator',verified_at=NOW(),updated_at=NOW() WHERE repository=$1 AND id=$2 AND revision=1 RETURNING revision",
          [REPO_A, recordA],
        ),
        pool.query(
          "UPDATE memory_records SET revision=revision+1,status='VERIFIED',verified_by='operator',verified_at=NOW(),updated_at=NOW() WHERE repository=$1 AND id=$2 AND revision=1 RETURNING revision",
          [REPO_A, recordA],
        ),
      ]);
      expect([a.rowCount, b.rowCount].sort()).toEqual([0, 1]);
      const r = await pool.query(
        'SELECT revision,status,text FROM memory_revisions WHERE repository=$1 AND memory_id=$2 ORDER BY revision',
        [REPO_A, recordA],
      );
      expect(r.rows).toHaveLength(2);
      expect(r.rows[0]).toEqual({ revision: 1, status: 'PROPOSED', text: 'Initial proposed note' });
      expect(r.rows[1].revision).toBe(2);
      expect(r.rows[1].status).toBe('VERIFIED');
      expect(r.rows[1].text).toBe('Initial proposed note');
    });
    it('rejects revision skip, historical UPDATE/DELETE and preserves approval on supersede', async () => {
      await expect(
        pool.query('UPDATE memory_records SET revision=10 WHERE id=$1', [recordA]),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          "UPDATE memory_revisions SET text='rewritten' WHERE memory_id=$1 AND revision=1",
          [recordA],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query('DELETE FROM memory_revisions WHERE memory_id=$1 AND revision=1', [recordA]),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query('DELETE FROM memory_records WHERE id=$1', [recordA]),
      ).rejects.toMatchObject({ code: 'P0001' });
      const newRecordId = randomUUID();
      await pool.query(
        "INSERT INTO memory_records(id,repository,scope,kind,text,updated_at) VALUES($1,$2,'PROJECT','DECISION','Replacement record',NOW())",
        [newRecordId, REPO_A],
      );
      await pool.query(
        "UPDATE memory_records SET status='SUPERSEDED',superseded_by_id=$1,revision=revision+1,updated_at=NOW() WHERE repository=$2 AND id=$3",
        [newRecordId, REPO_A, recordA],
      );
      const r = await pool.query(
        'SELECT revision,status,text FROM memory_revisions WHERE memory_id=$1 ORDER BY revision',
        [recordA],
      );
      expect(r.rows).toHaveLength(3);
      expect(r.rows.map((x) => x.status)).toEqual(['PROPOSED', 'VERIFIED', 'SUPERSEDED']);
    });
  },
);
