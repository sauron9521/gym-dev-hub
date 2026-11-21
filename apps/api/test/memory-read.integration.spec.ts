import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { MemoryReadPageSchema, MemoryReadRevisionsSchema } from '@gym-dev-hub/contracts';
import { resolveMemoryDatabaseConfiguration } from '../src/database/memory-database-policy.js';
import {
  MemoryQueryService,
  MemoryReadNotFoundError,
  MemoryReadValidationError,
} from '../src/memory/memory-query.service.js';

const eligible =
  process.env.DEV_HUB_MEMORY_ENABLE === 'true' && !!process.env.DEV_HUB_MEMORY_TEST_DATABASE_URL;
const REPO_A = 'sauron9521/gym-dev-hub';
const REPO_B = 'sauron9521/gym-platform';

describe.skipIf(!eligible)(
  'authenticated-scope-ready memory query engine (ephemeral PostgreSQL only)',
  () => {
    let db: pg.Pool;
    let service: MemoryQueryService;
    let taskA: string;
    let taskB: string;
    let sessionA: string;
    let agentA: string;
    let wrongRepoId: string;
    let expiredId: string;
    let noSourceId: string;
    let taskOnlyId: string;
    let sessionOnlyId: string;
    let privateAgentId: string;
    let proposedId: string;
    let githubOldId: string;
    let historyId: string;
    let projectIds: string[];
    const fixture = randomUUID();
    const contextA = () => ({ repository: REPO_A });
    const contextTask = () => ({ repository: REPO_A, taskId: taskA });
    const contextSession = () => ({
      repository: REPO_A,
      sessionId: sessionA,
      taskId: taskA,
      agentId: agentA,
    });

    async function insertMemory({
      repository = REPO_A,
      status = 'VERIFIED',
      scope = 'PROJECT',
      kind = 'FACT',
      text = `verified fixture ${fixture}`,
      taskId = null as string | null,
      sessionId = null as string | null,
      agentId = null as string | null,
      expiresAt = null as Date | null,
      sourceType = 'HUMAN' as string | null,
      sourceAge = '0 seconds',
      updatedOffset = '0 seconds',
    } = {}): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO memory_records
       (id,repository,scope,kind,status,text,revision,task_id,session_id,agent_id,expires_at,verified_by,verified_at,updated_at)
       VALUES ($1,$2,$3::"MemoryScope",$4::"MemoryKind",$5::"MemoryStatus",$6,1,$7,$8,$9,$10,$11::text,
         CASE WHEN $11::text IS NULL THEN NULL ELSE NOW() END,NOW() - ($12::interval))`,
        [
          id,
          repository,
          scope,
          kind,
          status,
          text,
          taskId,
          sessionId,
          agentId,
          expiresAt,
          status === 'VERIFIED' ? 'verified-operator' : null,
          updatedOffset,
        ],
      );
      if (sourceType) {
        await db.query(
          `INSERT INTO memory_sources(id,repository,memory_id,source_type,actor_id,source_ref,observed_at)
        VALUES($1,$2,$3,$4::"MemorySourceType",$5,$6,NOW()-($7::interval))`,
          [randomUUID(), repository, id, sourceType, 'reviewer', `fixture-${fixture}`, sourceAge],
        );
      }
      return id;
    }

    beforeAll(async () => {
      const config = resolveMemoryDatabaseConfiguration(process.env, 'test');
      if (!config.enabled || config.database !== 'gym_dev_hub_memory_test')
        throw new Error('Refusing non-test database');
      db = new pg.Pool({
        connectionString: config.url,
        ssl: false,
        max: 5,
        connectionTimeoutMillis: 4000,
      });
      const res = await db.query('SELECT current_database() AS db');
      if (res.rows[0]?.db !== 'gym_dev_hub_memory_test')
        throw new Error('Non-test database refused');
      service = new MemoryQueryService(db, randomBytes(32));
      await db.query(
        'INSERT INTO memory_repositories(name) VALUES($1),($2) ON CONFLICT DO NOTHING',
        [REPO_A, REPO_B],
      );
      taskA = randomUUID();
      taskB = randomUUID();
      sessionA = randomUUID();
      agentA = randomUUID();
      await db.query(
        'INSERT INTO memory_tasks(id,repository,external_ref) VALUES($1,$2,$3),($4,$5,$6)',
        [taskA, REPO_A, `task-${fixture}`, taskB, REPO_B, `task-${fixture}`],
      );
      await db.query(
        'INSERT INTO memory_agent_identities(id,repository,external_ref) VALUES($1,$2,$3)',
        [agentA, REPO_A, `agent-${fixture}`],
      );
      await db.query(
        'INSERT INTO memory_sessions(id,repository,external_ref,task_id,agent_id) VALUES($1,$2,$3,$4,$5)',
        [sessionA, REPO_A, `session-${fixture}`, taskA, agentA],
      );
      projectIds = [];
      for (let i = 0; i < 7; i++)
        projectIds.push(
          await insertMemory({
            text: `verified shared ${fixture} #${i}`,
            updatedOffset: `${7 - i} seconds`,
          }),
        );
      wrongRepoId = await insertMemory({ repository: REPO_B });
      expiredId = await insertMemory({ expiresAt: new Date(Date.now() - 60_000) });
      noSourceId = await insertMemory({ sourceType: null });
      proposedId = await insertMemory({ status: 'PROPOSED' });
      githubOldId = await insertMemory({ sourceType: 'GITHUB', sourceAge: '120 seconds' });
      taskOnlyId = await insertMemory({ scope: 'TASK', taskId: taskA });
      sessionOnlyId = await insertMemory({ scope: 'SESSION', sessionId: sessionA });
      privateAgentId = await insertMemory({ scope: 'PROJECT', agentId: agentA });
      historyId = await insertMemory({ status: 'PROPOSED' });
      await db.query(
        "UPDATE memory_records SET status='VERIFIED',verified_by='operator',verified_at=NOW(),revision=revision+1,updated_at=NOW() WHERE id=$1",
        [historyId],
      );
    });
    afterAll(async () => {
      await db?.end();
    });

    it('returns only verified sourced, non-expired and nonstale shared records', async () => {
      const first = await service.list(contextA(), { repository: REPO_A, limit: 50 });
      expect(MemoryReadPageSchema.safeParse(first).success).toBe(true);
      const ids = first.items.map((x) => x.record.id);
      for (const id of [...projectIds, historyId]) expect(ids).toContain(id);
      for (const id of [
        wrongRepoId,
        expiredId,
        noSourceId,
        proposedId,
        githubOldId,
        taskOnlyId,
        sessionOnlyId,
        privateAgentId,
      ])
        expect(ids).not.toContain(id);
      expect(first.nextCursor).toBe(null);
      expect(first.items[0]?.record.status).toBe('verified');
      expect(first.items[0]?.provenance.actorId).toBe('reviewer');
    });
    it('paginates deterministically with signed keyset cursor and no duplicates', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let turn = 0; turn < 10; turn++) {
        const page = await service.list(contextA(), {
          repository: REPO_A,
          limit: 3,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.items.map((x) => x.record.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(8);
      expect(projectIds.every((id) => seen.includes(id))).toBe(true);
    });
    it('rejects tampered, cross-repo, cross-context and cross-filter cursors', async () => {
      const first = await service.list(contextA(), { repository: REPO_A, limit: 2 });
      const token = first.nextCursor;
      expect(token).toBeTruthy();
      await expect(
        service.list(contextA(), {
          repository: REPO_A,
          limit: 2,
          cursor: token!.slice(0, -2) + 'XX',
        }),
      ).rejects.toBeInstanceOf(MemoryReadValidationError);
      await expect(
        service.list(contextTask(), { repository: REPO_A, limit: 2, cursor: token! }),
      ).rejects.toBeInstanceOf(MemoryReadValidationError);
      await expect(
        service.list(contextA(), {
          repository: REPO_A,
          kind: 'decision',
          limit: 2,
          cursor: token!,
        }),
      ).rejects.toBeInstanceOf(MemoryReadValidationError);
      await expect(
        service.list({ repository: REPO_B }, { repository: REPO_A, limit: 2, cursor: token! }),
      ).rejects.toBeInstanceOf(MemoryReadNotFoundError);
    });
    it('enforces repo and task filters from trusted context rather than query params', async () => {
      await expect(service.list(contextA(), { repository: REPO_B })).rejects.toBeInstanceOf(
        MemoryReadNotFoundError,
      );
      await expect(
        service.list(contextA(), { repository: REPO_A, taskId: taskA }),
      ).rejects.toBeInstanceOf(MemoryReadNotFoundError);
      await expect(
        service.list(contextTask(), { repository: REPO_A, taskId: taskB }),
      ).rejects.toBeInstanceOf(MemoryReadNotFoundError);
      const task = await service.list(contextTask(), {
        repository: REPO_A,
        scope: 'task',
        taskId: taskA,
      });
      expect(task.items.map((x) => x.record.id)).toEqual([taskOnlyId]);
      const wrong = await service.list(
        { repository: REPO_B, taskId: taskB },
        { repository: REPO_B, scope: 'task' },
      );
      expect(wrong.items).toEqual([]);
    });
    it('restricts session and agent-private records to the matching principal context', async () => {
      const context = contextSession();
      const page = await service.list(context, { repository: REPO_A, limit: 50 });
      expect(page.items.map((x) => x.record.id)).toEqual(
        expect.arrayContaining([taskOnlyId, sessionOnlyId, privateAgentId]),
      );
      await expect(service.get(contextA(), REPO_A, sessionOnlyId)).rejects.toBeInstanceOf(
        MemoryReadNotFoundError,
      );
      await expect(service.get(contextTask(), REPO_A, privateAgentId)).rejects.toBeInstanceOf(
        MemoryReadNotFoundError,
      );
    });
    it('returns 404 for unknown, unapproved, expired, unsourced, stale and cross-tenant records', async () => {
      for (const id of [
        wrongRepoId,
        expiredId,
        noSourceId,
        proposedId,
        githubOldId,
        taskOnlyId,
        sessionOnlyId,
        randomUUID(),
      ]) {
        await expect(service.get(contextA(), REPO_A, id)).rejects.toBeInstanceOf(
          MemoryReadNotFoundError,
        );
      }
      await expect(
        service.get({ repository: REPO_B }, REPO_B, projectIds[0]),
      ).rejects.toBeInstanceOf(MemoryReadNotFoundError);
    });
    it('returns only verified revision snapshots for accessible record', async () => {
      const history = await service.revisions(contextA(), REPO_A, historyId);
      expect(MemoryReadRevisionsSchema.safeParse(history).success).toBe(true);
      expect(history.revisions.map((r) => r.revision)).toEqual([2]);
      expect(history.revisions.every((r) => r.status === 'verified')).toBe(true);
      await expect(service.revisions(contextA(), REPO_A, wrongRepoId)).rejects.toBeInstanceOf(
        MemoryReadNotFoundError,
      );
      await expect(service.revisions(contextA(), REPO_A, proposedId)).rejects.toBeInstanceOf(
        MemoryReadNotFoundError,
      );
    });
    it('validates malicious filters and direct identifier before touching DB', async () => {
      await expect(service.list(contextA(), { repository: REPO_A, limit: 5000 })).rejects.toThrow();
      await expect(
        service.list(contextA(), { repository: REPO_A, sql: 'SELECT *' }),
      ).rejects.toThrow();
      await expect(service.get(contextA(), REPO_A, "' OR TRUE --")).rejects.toThrow();
    });
  },
);
