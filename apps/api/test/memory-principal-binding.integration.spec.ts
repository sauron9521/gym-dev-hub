import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryPrincipal } from '../src/security/memory-authorization.service.js';
import { resolveMemoryDatabaseConfiguration } from '../src/database/memory-database-policy.js';
import { verifyMemoryPrincipalBinding } from '../src/security/memory-principal-binding.js';

const enabled =
  process.env.DEV_HUB_MEMORY_ENABLE === 'true' &&
  Boolean(process.env.DEV_HUB_MEMORY_TEST_DATABASE_URL);
const repoA = 'sauron9521/gym-dev-hub';
const repoB = 'sauron9521/gym-platform';
const key = randomUUID();
const taskA = randomUUID();
const taskB = randomUUID();
const agentA = randomUUID();
const agentB = randomUUID();
const sessionA = randomUUID();
const sessionB = randomUUID();

const principal = (
  repository: string,
  args: { taskId?: string; agentId?: string; sessionId?: string } = {},
): MemoryPrincipal => ({
  type: args.agentId ? 'agent' : 'external',
  actorId: randomUUID(),
  repository,
  permission: 'READ_VERIFIED',
  readContext: { repository, ...args },
});

describe.skipIf(!enabled)('real DB memory bearer-scope membership (isolated PostgreSQL)', () => {
  let db: pg.Pool;

  beforeAll(async () => {
    const config = resolveMemoryDatabaseConfiguration(process.env, 'test');
    if (!config.enabled || config.database !== 'gym_dev_hub_memory_test')
      throw new Error('Test DB isolation guard');
    db = new pg.Pool({
      connectionString: config.url,
      ssl: false,
      max: 2,
      connectionTimeoutMillis: 4000,
    });
    const check = await db.query('SELECT current_database() AS name');
    if (check.rows[0]?.name !== 'gym_dev_hub_memory_test')
      throw new Error('Non-test database refused');
    await db.query(
      'INSERT INTO memory_repositories(name) VALUES ($1),($2) ON CONFLICT DO NOTHING',
      [repoA, repoB],
    );
    await db.query(
      'INSERT INTO memory_tasks(id,repository,external_ref) VALUES ($1,$2,$3),($4,$5,$6)',
      [taskA, repoA, `test-task-a-${key}`, taskB, repoB, `test-task-b-${key}`],
    );
    await db.query(
      'INSERT INTO memory_agent_identities(id,repository,external_ref) VALUES ($1,$2,$3),($4,$5,$6)',
      [agentA, repoA, `test-agent-a-${key}`, agentB, repoB, `test-agent-b-${key}`],
    );
    await db.query(
      'INSERT INTO memory_sessions(id,repository,external_ref,task_id,agent_id) VALUES ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)',
      [
        sessionA,
        repoA,
        `test-session-a-${key}`,
        taskA,
        agentA,
        sessionB,
        repoB,
        `test-session-b-${key}`,
        taskB,
        agentB,
      ],
    );
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.query('DELETE FROM memory_sessions WHERE id=ANY($1::uuid[])', [
        [sessionA, sessionB],
      ]);
      await db.query('DELETE FROM memory_agent_identities WHERE id=ANY($1::uuid[])', [
        [agentA, agentB],
      ]);
      await db.query('DELETE FROM memory_tasks WHERE id=ANY($1::uuid[])', [[taskA, taskB]]);
    } finally {
      await db.end();
    }
  });

  it('allows registered agent session, task-member and external registered-task reads', async () => {
    const exact = principal(repoA, { agentId: agentA, taskId: taskA, sessionId: sessionA });
    await expect(verifyMemoryPrincipalBinding(exact, db)).resolves.toEqual(exact);
    await expect(
      verifyMemoryPrincipalBinding(principal(repoA, { agentId: agentA, taskId: taskA }), db),
    ).resolves.toMatchObject({ repository: repoA });
    await expect(
      verifyMemoryPrincipalBinding(principal(repoA, { taskId: taskA }), db),
    ).resolves.toMatchObject({ repository: repoA });
    await expect(verifyMemoryPrincipalBinding(principal(repoA), db)).resolves.toMatchObject({
      repository: repoA,
    });
  });

  it('denies foreign repo IDs, unrelated agent-task pairing and a mismatched session', async () => {
    for (const mismatched of [
      principal(repoB, { agentId: agentA }),
      principal(repoA, { taskId: taskB }),
      principal(repoA, { agentId: agentA, taskId: taskB }),
      principal(repoA, { agentId: agentA, taskId: taskA, sessionId: sessionB }),
      principal(repoB, { agentId: agentB, taskId: taskB, sessionId: sessionA }),
      principal(repoA, { agentId: randomUUID() }),
      principal(repoA, { taskId: randomUUID() }),
      principal('sauron9521/unknown'),
    ]) {
      await expect(verifyMemoryPrincipalBinding(mismatched, db)).rejects.toMatchObject({
        code: 'forbidden',
      });
    }
  });
});
