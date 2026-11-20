import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskRunnerPreview } from '@gym-dev-hub/contracts';
import { TaskExecutionGrantService } from '../src/worktree/task-execution-grant.service.js';

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const MANIFEST = 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';
const SECRET = 'separate-strong-task-operator-secret-1234567890';

function goodPreview(): TaskRunnerPreview {
  return {
    sessionId: SESSION,
    planId: PLAN,
    repository: 'sauron9521/gym-platform',
    recipeId: 'API_TYPECHECK',
    label: 'API — TypeScript',
    baseHeadSha: COMMIT,
    fingerprint: FINGERPRINT,
    generatedAt: new Date().toISOString(),
    argv: ['pnpm', '--filter', '@gym/api', 'typecheck'],
    workingDirectory: '/workspace',
    proposedBoundary: {
      network: 'none',
      sourceMount: 'read-only',
      writableArea: 'ephemeral-tmpfs',
      uid: 'non-root',
      dockerSocket: false,
      environmentSecrets: false,
      maxDurationSeconds: 600,
      maxMemoryMiB: 2048,
      maxCpus: 2,
      maxPids: 128,
      maxOutputBytes: 65536,
    },
    status: 'preview-only',
    executionEnabled: false,
    approvalGranted: false,
    runnerImageAvailable: false,
    executesUntrustedProjectScripts: true,
    notes: [],
  };
}

function approval() {
  return {
    recipeId: 'API_TYPECHECK',
    fingerprint: FINGERPRINT,
    sourceCommit: COMMIT,
    sourceTree: TREE,
    sourceManifestSha256: MANIFEST,
    confirmation: 'I_APPROVE_API_TYPECHECK_ON_PINNED_SOURCE_ONLY',
    operatorSecret: SECRET,
  };
}

function consumption(token: string) {
  return {
    grantToken: token,
    recipeId: 'API_TYPECHECK',
    fingerprint: FINGERPRINT,
    sourceCommit: COMMIT,
    sourceManifestSha256: MANIFEST,
  };
}

describe('one-time fixed API_TYPECHECK authorization (without a runner)', () => {
  let dir: string;
  let path: string;
  let service: TaskExecutionGrantService;
  const policy = { preview: vi.fn() };

  beforeEach(async () => {
    vi.restoreAllMocks();
    policy.preview.mockReset();
    policy.preview.mockImplementation(async () => goodPreview());
    dir = await mkdtemp(join(tmpdir(), 'devhub-task-grants-'));
    path = join(dir, 'grants.audit.jsonl');
    process.env.DEV_HUB_ENABLE_TASK_GRANTS = 'true';
    process.env.DEV_HUB_TASK_GRANT_OPERATOR_SECRET = SECRET;
    process.env.DEV_HUB_TASK_GRANT_AUDIT_FILE = path;
    service = new TaskExecutionGrantService(policy as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.DEV_HUB_ENABLE_TASK_GRANTS;
    delete process.env.DEV_HUB_TASK_GRANT_OPERATOR_SECRET;
    delete process.env.DEV_HUB_TASK_GRANT_AUDIT_FILE;
    await rm(dir, { force: true, recursive: true });
  });

  async function issue() {
    return service.authorize(SESSION, PLAN, approval());
  }

  async function records() {
    return (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; grantId: string; sourceCommit: string });
  }

  it('is disabled by default even if a request includes an operator secret', async () => {
    delete process.env.DEV_HUB_ENABLE_TASK_GRANTS;
    await expect(issue()).rejects.toThrow('вимкнена');
    expect(policy.preview).not.toHaveBeenCalled();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires an independently configured strong operator secret', async () => {
    delete process.env.DEV_HUB_TASK_GRANT_OPERATOR_SECRET;
    await expect(issue()).rejects.toThrow('окремий сильний секрет');
    process.env.DEV_HUB_TASK_GRANT_OPERATOR_SECRET = 'weak';
    await expect(issue()).rejects.toThrow('окремий сильний секрет');
    process.env.DEV_HUB_TASK_GRANT_OPERATOR_SECRET = SECRET;
    await expect(
      service.authorize(SESSION, PLAN, { ...approval(), operatorSecret: 'x'.repeat(44) }),
    ).rejects.toThrow('Невірний секрет');
    expect(policy.preview).not.toHaveBeenCalled();
  });

  it('rejects all unsupported recipes, shell commands, forged commit/tree/manifest and missing confirmation', async () => {
    const invalid = [
      { ...approval(), recipeId: 'API_TEST' },
      { ...approval(), recipeId: 'WEB_TYPECHECK' },
      { ...approval(), recipeId: 'npm run preinstall' },
      { ...approval(), argv: ['sh', '-c', 'echo bad'] },
      { ...approval(), shell: true },
      { ...approval(), sourceCommit: 'c'.repeat(40) },
      { ...approval(), sourceTree: 'd'.repeat(40) },
      { ...approval(), sourceManifestSha256: 'e'.repeat(64) },
      { ...approval(), confirmation: 'I_APPROVE_ANYTHING' },
      { ...approval(), fingerprint: 'sha256:' + 'z'.repeat(64) },
    ];
    for (const input of invalid) {
      await expect(service.authorize(SESSION, PLAN, input)).rejects.toThrow();
    }
    expect(policy.preview).not.toHaveBeenCalled();
  });

  it('binds issued capability to the exact reviewed recipe, Git commit/tree/manifest and worktree', async () => {
    const grant = await issue();
    expect(grant).toMatchObject({
      recipeId: 'API_TYPECHECK',
      sourceCommit: COMMIT,
      sourceTree: TREE,
      sourceManifestSha256: MANIFEST,
      fingerprint: FINGERPRINT,
      purpose: 'AUTHORIZE_ONE_PINNED_API_TYPECHECK',
      executionEnabled: false,
    });
    expect(grant.grantToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grant.grantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(grant.expiresAt) - Date.now()).toBeLessThanOrEqual(45_000);
    expect(policy.preview).toHaveBeenCalledWith(SESSION, PLAN, {
      recipeId: 'API_TYPECHECK',
      fingerprint: FINGERPRINT,
    });
    const serialized = await readFile(path, 'utf8');
    expect(serialized).not.toContain(grant.grantToken);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('/fixture/');
    expect(await records()).toMatchObject([
      { event: 'issued', grantId: grant.grantId, sourceCommit: COMMIT },
    ]);
  });

  it.each([
    ['wrong worktree commit', { baseHeadSha: 'f'.repeat(40) }],
    ['wrong recipe', { recipeId: 'WEB_TYPECHECK' }],
    ['wrong session', { sessionId: 'another' }],
    ['fake approval state', { approvalGranted: true }],
    ['execution unexpectedly enabled', { executionEnabled: true }],
    ['command injected', { argv: ['sh', '-c', 'exit 0'] }],
    ['source mount becomes writable', { proposedBoundary: { ...goodPreview().proposedBoundary, sourceMount: 'writable' } }],
    ['network requested', { proposedBoundary: { ...goodPreview().proposedBoundary, network: 'bridge' } }],
    ['changed fingerprint', { fingerprint: 'sha256:' + 'c'.repeat(64) }],
  ])('fails closed on preview drift: %s', async (_label, change) => {
    policy.preview.mockResolvedValueOnce({ ...goodPreview(), ...change });
    await expect(issue()).rejects.toThrow('не відповідають затвердженим');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('atomically consumes once under concurrent requests and never enables execution', async () => {
    const grant = await issue();
    const payload = consumption(grant.grantToken);
    const results = await Promise.allSettled([
      service.consumeForPolicyCheck(SESSION, PLAN, payload),
      service.consumeForPolicyCheck(SESSION, PLAN, payload),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const ok = results.find((r) => r.status === 'fulfilled');
    if (ok?.status !== 'fulfilled') throw new Error('Consumption unexpectedly failed');
    expect(ok.value).toEqual({
      grantId: grant.grantId,
      recipeId: 'API_TYPECHECK',
      status: 'consumed-no-execution',
      executionEnabled: false,
    });
    expect((await records()).map((event) => event.event)).toEqual(['issued', 'consumed']);
    await expect(service.consumeForPolicyCheck(SESSION, PLAN, payload)).rejects.toThrow('Дозвіл');
  });

  it('disallows wrong plan, session, recipe or fingerprint; leaked tokens cannot be used for other work', async () => {
    const grant = await issue();
    await expect(
      service.consumeForPolicyCheck('other-session', PLAN, consumption(grant.grantToken)),
    ).rejects.toThrow('Дозвіл');
    await expect(
      service.consumeForPolicyCheck(SESSION, PLAN, consumption(grant.grantToken)),
    ).rejects.toThrow('Дозвіл');

    const grant2 = await issue();
    await expect(
      service.consumeForPolicyCheck(SESSION, 'another-plan', consumption(grant2.grantToken)),
    ).rejects.toThrow('Дозвіл');

    const grant3 = await issue();
    await expect(
      service.consumeForPolicyCheck(SESSION, PLAN, {
        ...consumption(grant3.grantToken),
        fingerprint: 'sha256:' + 'f'.repeat(64),
      }),
    ).rejects.toThrow('Дозвіл');

    const grant4 = await issue();
    await expect(
      service.consumeForPolicyCheck(SESSION, PLAN, {
        ...consumption(grant4.grantToken),
        recipeId: 'WEB_LINT',
      }),
    ).rejects.toThrow('Некоректні');
  });

  it('rechecks live worktree integrity when consuming and burns the grant on policy drift', async () => {
    const grant = await issue();
    policy.preview.mockResolvedValueOnce({ ...goodPreview(), baseHeadSha: '1'.repeat(40) });
    await expect(
      service.consumeForPolicyCheck(SESSION, PLAN, consumption(grant.grantToken)),
    ).rejects.toThrow('анульовано');
    await expect(
      service.consumeForPolicyCheck(SESSION, PLAN, consumption(grant.grantToken)),
    ).rejects.toThrow('Дозвіл');
    expect((await records()).map((item) => item.event)).toEqual(['issued', 'consume-denied']);
  });

  it('supports explicit revocation and rejects a revoked token on later consume', async () => {
    const grant = await issue();
    const revoked = await service.revoke(SESSION, PLAN, {
      grantToken: grant.grantToken,
      operatorSecret: SECRET,
    });
    expect(revoked).toEqual({ grantId: grant.grantId, status: 'revoked', executionEnabled: false });
    await expect(
      service.consumeForPolicyCheck(SESSION, PLAN, consumption(grant.grantToken)),
    ).rejects.toThrow('Дозвіл');
    expect((await records()).map((item) => item.event)).toEqual(['issued', 'revoked']);
  });

  it('requires an operator secret to revoke and cannot revoke another session or plan', async () => {
    const grant = await issue();
    await expect(
      service.revoke(SESSION, PLAN, {
        grantToken: grant.grantToken,
        operatorSecret: 'x'.repeat(50),
      }),
    ).rejects.toThrow('Невірний секрет');
    await expect(
      service.revoke(SESSION, 'another-plan', {
        grantToken: grant.grantToken,
        operatorSecret: SECRET,
      }),
    ).rejects.toThrow('Дозвіл');
    await expect(
      service.revoke(SESSION, PLAN, { grantToken: grant.grantToken, operatorSecret: SECRET }),
    ).rejects.toThrow('Дозвіл');
  });

  it('expires after 45 seconds and never reactivates on a second use', async () => {
    const grant = await issue();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 46_000);
    await expect(
      service.consumeForPolicyCheck(SESSION, PLAN, consumption(grant.grantToken)),
    ).rejects.toThrow('Дозвіл');
    await expect(
      service.consumeForPolicyCheck(SESSION, PLAN, consumption(grant.grantToken)),
    ).rejects.toThrow('Дозвіл');
  });

  it('clears grants when switched off, so re-enabling cannot revive them', async () => {
    const grant = await issue();
    process.env.DEV_HUB_ENABLE_TASK_GRANTS = 'false';
    await expect(
      service.consumeForPolicyCheck(SESSION, PLAN, consumption(grant.grantToken)),
    ).rejects.toThrow('вимкнена');
    process.env.DEV_HUB_ENABLE_TASK_GRANTS = 'true';
    await expect(
      service.consumeForPolicyCheck(SESSION, PLAN, consumption(grant.grantToken)),
    ).rejects.toThrow('Дозвіл');
  });

  it('fails closed without a durable audit file, including a redirected symlink', async () => {
    const forbidden = join(dir, 'target.txt');
    await writeFile(forbidden, 'do not modify\n');
    await symlink(forbidden, path);
    await expect(issue()).rejects.toThrow('журнал');
    expect(await readFile(forbidden, 'utf8')).toBe('do not modify\n');
  });

  it('invalidates grants across service restarts because no bearer tokens are persisted', async () => {
    const grant = await issue();
    const newService = new TaskExecutionGrantService(policy as never);
    await expect(
      newService.consumeForPolicyCheck(SESSION, PLAN, consumption(grant.grantToken)),
    ).rejects.toThrow('Дозвіл');
    expect((await records()).map((item) => item.event)).toEqual(['issued']);
  });
});
