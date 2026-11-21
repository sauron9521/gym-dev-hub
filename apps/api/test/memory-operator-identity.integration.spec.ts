import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { resolveMemoryDatabaseConfiguration } from '../src/database/memory-database-policy.js';
import { MemoryAuthorizationService } from '../src/security/memory-authorization.service.js';
import { MemoryOperatorIdentityService } from '../src/security/memory-operator-identity.service.js';

const eligible =
  process.env.DEV_HUB_MEMORY_ENABLE === 'true' &&
  Boolean(process.env.DEV_HUB_MEMORY_TEST_DATABASE_URL);
const repository = 'sauron9521/gym-dev-hub';
const root = 'test-only-hub-identity-bootstrap-operator-secret-48bytes';
const env: NodeJS.ProcessEnv = {
  DEV_HUB_MEMORY_ENABLE: 'true',
  DEV_HUB_MEMORY_SECURITY_ENABLE: 'true',
  DEV_HUB_MEMORY_OPERATOR_SECRET: root,
  DEV_HUB_MEMORY_ALLOWED_REPOSITORIES: repository,
  DEV_HUB_MEMORY_TRUSTED_ORIGIN: 'http://127.0.0.1:3100',
  DEV_HUB_MEMORY_OPERATOR_IDENTITIES_HTTP_ENABLE: 'true',
};
const handle = (prefix: string) => prefix + '_' + randomUUID().replaceAll('-', '').slice(0, 12);

describe.skipIf(!eligible)(
  'isolated PostgreSQL operator credential holder and role isolation',
  () => {
    let pool: pg.Pool;
    let service: MemoryOperatorIdentityService;
    let auth: MemoryAuthorizationService;
    beforeAll(async () => {
      const conf = resolveMemoryDatabaseConfiguration(process.env, 'test');
      if (!conf.enabled || conf.database !== 'gym_dev_hub_memory_test')
        throw Error('Refusing operator identity test on non-test DB');
      env.DEV_HUB_MEMORY_TEST_DATABASE_URL = conf.url;
      pool = new pg.Pool({
        connectionString: conf.url,
        ssl: false,
        max: 4,
        connectionTimeoutMillis: 4000,
      });
      const check = await pool.query('SELECT current_database() AS db');
      if (check.rows[0]?.db !== 'gym_dev_hub_memory_test')
        throw Error('Wrong operator identity test DB');
      await pool.query('INSERT INTO memory_repositories(name) VALUES($1) ON CONFLICT DO NOTHING', [
        repository,
      ]);
      auth = new MemoryAuthorizationService(env);
      service = new MemoryOperatorIdentityService(auth, env, undefined, 'test');
    });
    afterAll(async () => {
      if (pool) await pool.end();
    });

    it('mints a 256-bit token once, persists only a hash, and survives a new verifier process', async () => {
      const registration = await service.issue(root, {
        repository,
        handle: handle('reviewer'),
        role: 'REVIEWER',
        ttlSeconds: 120,
      });
      expect(registration).toMatchObject({ repository, role: 'REVIEWER' });
      expect(registration.bearerToken).toMatch(/^mop_[A-Za-z0-9_-]{43}$/);
      const row = await pool.query(
        'SELECT id,token_digest,role,created_at,expires_at,revoked_at FROM memory_operator_identities WHERE id=$1',
        [registration.identityId],
      );
      expect(row.rows).toHaveLength(1);
      const persisted = row.rows[0];
      expect(persisted).toMatchObject({ role: 'REVIEWER', revoked_at: null });
      expect(persisted.token_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(persisted.token_digest).not.toContain(registration.bearerToken);
      expect(persisted.token_digest).toBe(
        createHash('sha256')
          .update('gym-dev-hub:operator-identity:v1\0')
          .update(registration.bearerToken)
          .digest('hex'),
      );
      expect(persisted.created_at).toBeInstanceOf(Date);
      expect(persisted.expires_at).toBeInstanceOf(Date);
      const fresh = new MemoryOperatorIdentityService(
        new MemoryAuthorizationService(env),
        env,
        undefined,
        'test',
      );
      expect(
        await fresh.verify(registration.bearerToken, repository, 'APPROVE_MEMORY_PROPOSAL'),
      ).toMatchObject({
        identityId: registration.identityId,
        repository,
        role: 'REVIEWER',
        permissions: expect.arrayContaining(['APPROVE_MEMORY_PROPOSAL', 'SUPERSEDE_MEMORY_RECORD']),
      });
      const rows = await pool.query(
        'SELECT action,actor,repository FROM memory_operator_identity_audit WHERE operator_id=$1',
        [registration.identityId],
      );
      expect(rows.rows).toEqual([{ action: 'ISSUED', actor: 'bootstrap-root', repository }]);
    });

    it('AUDITOR can inspect only metadata, never approve, and grants cannot impersonate across repos', async () => {
      const registered = await service.issue(root, {
        repository,
        handle: handle('auditor'),
        role: 'AUDITOR',
        ttlSeconds: 3600,
      });
      expect(
        await service.verify(registered.bearerToken, repository, 'READ_OPERATOR_METADATA'),
      ).toMatchObject({
        identityId: registered.identityId,
        role: 'AUDITOR',
        permissions: ['READ_OPERATOR_METADATA'],
      });
      await expect(
        service.verify(registered.bearerToken, repository, 'APPROVE_MEMORY_PROPOSAL'),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.verify(
          registered.bearerToken,
          'different-owner/some-repo',
          'READ_OPERATOR_METADATA',
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.verify('mop_' + '0'.repeat(43), repository, 'READ_OPERATOR_METADATA'),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        service.issue('wrong-root', {
          repository,
          handle: handle('impostor'),
          role: 'REVIEWER',
          ttlSeconds: 60,
        }),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(
        service.issue(root, {
          repository,
          handle: handle('fake'),
          role: 'SUPERADMIN',
          ttlSeconds: 60,
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.issue(root, {
          repository,
          handle: handle('fake'),
          role: 'REVIEWER',
          ttlSeconds: 90001,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('revokes independently across processes without restoring a token; append-only event audit', async () => {
      const account = await service.issue(root, {
        repository,
        handle: handle('holder'),
        role: 'REVIEWER',
        ttlSeconds: 3600,
      });
      const independent = new MemoryOperatorIdentityService(
        new MemoryAuthorizationService(env),
        env,
        undefined,
        'test',
      );
      expect(
        (await independent.verify(account.bearerToken, repository, 'REVOKE_MEMORY_RECORD'))
          .identityId,
      ).toBe(account.identityId);
      expect(await service.revoke(root, account.identityId, { repository })).toEqual({
        revoked: true,
      });
      await expect(
        independent.verify(account.bearerToken, repository, 'REVOKE_MEMORY_RECORD'),
      ).rejects.toMatchObject({ status: 401 });
      expect(await service.revoke(root, account.identityId, { repository })).toEqual({
        revoked: false,
      });
      const audit = await pool.query(
        'SELECT action,actor FROM memory_operator_identity_audit WHERE operator_id=$1 ORDER BY created_at',
        [account.identityId],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['ISSUED', 'REVOKED']);
      expect(audit.rows.every((r) => r.actor === 'bootstrap-root')).toBe(true);
      await expect(
        pool.query("UPDATE memory_operator_identities SET role='AUDITOR' WHERE id=$1", [
          account.identityId,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query('UPDATE memory_operator_identities SET revoked_at=NULL WHERE id=$1', [
          account.identityId,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query('DELETE FROM memory_operator_identity_audit WHERE operator_id=$1', [
          account.identityId,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('refuses expiry, and two concurrent attempts cannot register the same handle twice', async () => {
      const token = 'mop_' + 'X'.repeat(43);
      const hashed = createHash('sha256')
        .update('gym-dev-hub:operator-identity:v1\0')
        .update(token)
        .digest('hex');
      const stale = handle('expired');
      await pool.query(
        `INSERT INTO memory_operator_identities
       (repository,handle,role,token_digest,created_at,expires_at)
       VALUES($1,$2,'REVIEWER',$3,NOW() - interval '2 hours',
         NOW() - interval '1 hour')`,
        [repository, stale, hashed],
      );
      await expect(
        service.verify(token, repository, 'READ_OPERATOR_METADATA'),
      ).rejects.toMatchObject({ status: 401 });
      const collision = handle('collision');
      const attempts = await Promise.allSettled([
        service.issue(root, { repository, handle: collision, role: 'AUDITOR', ttlSeconds: 120 }),
        service.issue(root, { repository, handle: collision, role: 'REVIEWER', ttlSeconds: 120 }),
      ]);
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      const failed = attempts.find((a) => a.status === 'rejected');
      if (failed?.status === 'rejected') expect(failed.reason).toMatchObject({ status: 409 });
      const ids = await pool.query(
        'SELECT id FROM memory_operator_identities WHERE repository=$1 AND handle=$2',
        [repository, collision],
      );
      expect(ids.rows).toHaveLength(1);
      const rows = await pool.query(
        'SELECT count(*)::int AS n FROM memory_operator_identity_audit WHERE operator_id=$1',
        [ids.rows[0].id],
      );
      expect(rows.rows[0].n).toBe(1);
    });

    it('rolls back identity creation when audit insertion fails, with no visible token', async () => {
      const uniqueHandle = handle('rollback');
      const failing = new MemoryOperatorIdentityService(
        auth,
        env,
        (url) => {
          const inner = new pg.Pool({ connectionString: url, ssl: false, max: 1 });
          return {
            connect: async () => {
              const client = await inner.connect();
              return {
                query: async (sql: string, args?: unknown[]) => {
                  if (sql.includes('INSERT INTO memory_operator_identity_audit'))
                    throw Error('private simulated audit failure');
                  return client.query(sql, args);
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
        failing.issue(root, {
          repository,
          handle: uniqueHandle,
          role: 'REVIEWER',
          ttlSeconds: 3600,
        }),
      ).rejects.toMatchObject({ status: 503 });
      const rows = await pool.query(
        'SELECT id FROM memory_operator_identities WHERE repository=$1 AND handle=$2',
        [repository, uniqueHandle],
      );
      expect(rows.rows).toHaveLength(0);
    });
  },
);
