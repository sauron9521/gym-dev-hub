/**
 * Real Nest HTTP routes + real single-use authorization and fsynced audit.
 * Only pinned Docker execution and the already-reviewed plan/worktree are
 * fixtures; no host Docker, GitHub writes, secrets, or production audit.
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreePlanController } from '../src/worktree/worktree-plan.controller.js';
import { WorktreePatchChecksService } from '../src/worktree/worktree-patch-checks.service.js';
import { appendPatchCheckAudit } from '../src/worktree/worktree-patch-check-audit.js';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  execute: vi.fn(),
  mirror: vi.fn(),
}));
vi.mock('../src/worktree/worktree-patch-check-stage.js', () => ({
  withPatchCheckSourceStage: (_source: string, callback: (stage: string) => Promise<unknown>) =>
    callback('/synthetic-reviewed-source'),
}));
vi.mock('../src/worktree/worktree-patch-check-store-stage.js', () => ({
  withPatchCheckStoreStage: mocks.mirror,
}));
vi.mock('../src/worktree/worktree-patch-checks-docker.js', () => ({
  preparePatchCheckRunner: mocks.prepare,
  runPatchChecksDocker: mocks.execute,
}));

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const REVIEW_GRANT = '00000000-0000-4000-8000-000000000777';
const COMMIT = 'a'.repeat(40);
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const SOURCE_SHA = 'c'.repeat(64);
const AFTER_SHA = 'd'.repeat(64);
const FILE = 'apps/web/src/app/page.tsx';
const SECRET = 'isolated-http-check-secret-with-more-than-32-bytes';
const REVIEW_SECRET = 'isolated-http-review-secret-with-more-than-32-bytes';
const PATH = `/workspace/sessions/${SESSION}/worktree-plans/${PLAN}/patch-check-`;

const check = () => ({
  grantId: REVIEW_GRANT,
  fingerprint: FINGERPRINT,
  sourceCommit: COMMIT,
  filePath: FILE,
  sourceSha256: SOURCE_SHA,
  proposedSha256: AFTER_SHA,
  recipeId: 'WEB_FORMAT',
});
const approval = () => ({
  ...check(),
  confirmation: 'I_APPROVE_ONE_FIXED_DOCKER_CHECK',
  reviewOperatorSecret: REVIEW_SECRET,
  operatorSecret: SECRET,
});
const execution = (token: string, runId = randomUUID()) => ({
  ...check(),
  grantToken: token,
  runId,
  reviewOperatorSecret: REVIEW_SECRET,
  operatorSecret: SECRET,
});
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

describe('real Nest HTTP one-time fixed Docker grants and durable audit (isolated fixture)', () => {
  let app: INestApplication | undefined;
  let base: string;
  let endpoint: string;
  let plans: {
    list: ReturnType<typeof vi.fn>;
    availableForMountProbe: ReturnType<typeof vi.fn>;
  };
  let review: { review: ReturnType<typeof vi.fn> };
  let boundary: { status: ReturnType<typeof vi.fn> };
  const previousEnv = new Map<string, string | undefined>();
  const keys = [
    'DEV_HUB_PATCH_CHECK_STATE_DIR',
    'DEV_HUB_ENABLE_PATCH_CHECKS',
    'DEV_HUB_PATCH_CHECK_OPERATOR_SECRET',
    'DEV_HUB_PATCH_CHECK_PNPM_STORE',
  ];

  async function startHttp() {
    const checks = new WorktreePatchChecksService(
      plans as never,
      review as never,
      boundary as never,
    );
    // Vitest does not emit Nest constructor parameter metadata here.
    // Use the real production controller routes, injecting only the check
    // service; other handlers are never invoked in this localhost fixture.
    @Module({ controllers: [WorktreePlanController] })
    class IsolatedPatchCheckHttpModule {}
    app = await NestFactory.create(IsolatedPatchCheckHttpModule, { logger: false });
    const controller = app.get(WorktreePlanController) as unknown as {
      patchChecks: WorktreePatchChecksService;
    };
    controller.patchChecks = checks;
    await app.listen(0, '127.0.0.1');
    endpoint = await app.getUrl();
  }

  async function restartHttp() {
    await app?.close();
    app = undefined;
    await startHttp(); // fresh in-memory grants, same private disk journal
  }

  function post(action: string, payload: unknown): Promise<Response> {
    return fetch(endpoint + PATH + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
    });
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    for (const key of keys) previousEnv.set(key, process.env[key]);
    base = await mkdtemp(join(tmpdir(), 'devhub-patch-http-'));
    process.env.DEV_HUB_PATCH_CHECK_STATE_DIR = join(base, 'isolated-audit');
    process.env.DEV_HUB_ENABLE_PATCH_CHECKS = 'true';
    process.env.DEV_HUB_PATCH_CHECK_OPERATOR_SECRET = SECRET;
    process.env.DEV_HUB_PATCH_CHECK_PNPM_STORE = '/synthetic-pinned-store';
    plans = {
      list: vi.fn().mockResolvedValue([{ id: PLAN, repository: 'sauron9521/gym-dev-hub' }]),
      availableForMountProbe: vi.fn().mockResolvedValue({
        repository: 'sauron9521/gym-dev-hub',
        fingerprint: FINGERPRINT,
        baseHeadSha: COMMIT,
        targetPath: '/synthetic-reviewed-worktree',
      }),
    };
    review = {
      review: vi.fn().mockResolvedValue({
        status: 'verified',
        changedFiles: 1,
        sourceCommit: COMMIT,
        proposedSha256: AFTER_SHA,
        filePath: FILE,
      }),
    };
    boundary = {
      status: vi.fn().mockImplementation(() => ({
        state: 'passed',
        checkedAt: new Date().toISOString(),
      })),
    };
    mocks.mirror.mockImplementation(
      (
        _store: string,
        _lock: string,
        _signal: AbortSignal,
        action: (stage: string) => Promise<unknown>,
      ) => action('/synthetic-verified-store'),
    );
    mocks.prepare.mockResolvedValue({
      imageId: 'sha256:' + 'a'.repeat(64),
      mounts: [{ source: '/synthetic-reviewed-source', target: '/source' }],
    });
    mocks.execute.mockResolvedValue({
      stdoutBytes: 21,
      stderrBytes: 0,
      stageFiles: 20,
      stageBytes: 800,
      containerRemoved: true,
    });
    await startHttp();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const key of keys) {
      const old = previousEnv.get(key);
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
    previousEnv.clear();
    await rm(base, { recursive: true, force: true });
  });

  it('requires a real HTTP grant, executes once, records sanitized passed and survives HTTP restart', async () => {
    const unauthorized = await post('authorize', { ...approval(), operatorSecret: 'x'.repeat(43) });
    expect(unauthorized.status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();

    const issued = await post('authorize', approval());
    expect(issued.status).toBe(201);
    const grant = (await issued.json()) as { grantId: string; grantToken: string; purpose: string };
    expect(grant).toMatchObject({ purpose: 'AUTHORIZE_ONE_FIXED_POST_APPLY_DOCKER_CHECK' });
    expect(grant.grantToken).toHaveLength(43);

    const request = execution(grant.grantToken);
    const ran = await post('execute', request);
    expect(ran.status).toBe(201);
    const result = (await ran.json()) as { status: string; containerRemoved: boolean };
    expect(result).toMatchObject({ status: 'passed', containerRemoved: true });
    expect(mocks.prepare).toHaveBeenCalledWith(
      '/synthetic-reviewed-source',
      '/synthetic-verified-store',
    );
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    const history = await post('history', { operatorSecret: SECRET });
    expect(history.status).toBe(201);
    expect(await history.json()).toMatchObject({
      total: 1,
      readOnly: true,
      rawLogsAvailable: false,
      items: [{ status: 'passed', grantId: grant.grantId, recipeId: 'WEB_FORMAT' }],
    });

    const replay = await post('execute', request);
    expect(replay.status).toBe(409);
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    const journal = await readFile(join(base, 'isolated-audit', 'audit.jsonl'), 'utf8');
    expect(journal).toContain('"event":"passed"');
    expect(journal).toContain('"event":"issued"');
    expect(journal).toContain('"event":"attempted"');
    for (const forbidden of [SECRET, REVIEW_SECRET, grant.grantToken, FILE]) {
      expect(journal).not.toContain(forbidden);
    }
    expect(journal).toContain(digest(FILE));

    await restartHttp();
    const persisted = await post('history', { operatorSecret: SECRET });
    expect(persisted.status).toBe(201);
    expect(await persisted.json()).toMatchObject({
      total: 1,
      items: [{ status: 'passed', grantId: grant.grantId }],
    });
    const afterRestartReplay = await post('execute', request);
    expect(afterRestartReplay.status).toBe(409);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('persisted attempted-without-terminal remains interrupted after HTTP restart, without Docker replay', async () => {
    const issued = await post('authorize', approval());
    expect(issued.status).toBe(201);
    const grant = (await issued.json()) as { grantId: string; grantToken: string };
    const runId = randomUUID();
    // Emulates abrupt process loss after a durably fsynced attempted event.
    await appendPatchCheckAudit(
      'attempted',
      {
        id: grant.grantId,
        sessionId: SESSION,
        planId: PLAN,
        recipeId: 'WEB_FORMAT',
        fingerprint: FINGERPRINT,
        sourceCommit: COMMIT,
        sourceSha256: SOURCE_SHA,
        proposedSha256: AFTER_SHA,
        filePath: FILE,
      },
      runId,
    );
    await restartHttp();

    const history = await post('history', { operatorSecret: SECRET });
    expect(history.status).toBe(201);
    expect(await history.json()).toMatchObject({
      total: 1,
      items: [{ status: 'interrupted', grantId: grant.grantId, runId }],
    });
    const stale = await post('execute', execution(grant.grantToken, runId));
    expect(stale.status).toBe(409);
    expect(mocks.execute).not.toHaveBeenCalled();
    const journal = await readFile(join(base, 'isolated-audit', 'audit.jsonl'), 'utf8');
    expect(journal).not.toContain('"event":"passed"');
  });

  it('canceling a running HTTP Docker check persists cancel-requested then canceled, never passed', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.execute.mockImplementationOnce(
      async (
        _prepared: unknown,
        _recipe: unknown,
        _file: unknown,
        _sha: unknown,
        signal: AbortSignal,
      ) => {
        await blocked;
        if (signal.aborted) throw new Error('intentional fixture cancellation');
        return { stdoutBytes: 1, stderrBytes: 0, containerRemoved: true };
      },
    );
    const issued = await post('authorize', approval());
    expect(issued.status).toBe(201);
    const grant = (await issued.json()) as { grantToken: string };
    const request = execution(grant.grantToken);
    const inflight = post('execute', request);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    const cancel = await post('cancel', {
      runId: request.runId,
      operatorSecret: SECRET,
    });
    expect(cancel.status).toBe(201);
    expect(await cancel.json()).toMatchObject({
      status: 'cancel-requested',
      runId: request.runId,
    });
    const during = await post('history', { operatorSecret: SECRET });
    expect(during.status).toBe(201);
    expect(await during.json()).toMatchObject({
      total: 1,
      items: [{ status: 'cancel-requested' }],
    });
    release();
    const finished = await inflight;
    expect(finished.status).toBe(503);
    await restartHttp();
    const after = await post('history', { operatorSecret: SECRET });
    expect(after.status).toBe(201);
    expect(await after.json()).toMatchObject({
      total: 1,
      items: [{ status: 'canceled' }],
    });
    const lines = (await readFile(join(base, 'isolated-audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string });
    expect(lines.map((x) => x.event)).toEqual([
      'issued',
      'attempted',
      'cancel-requested',
      'rejected',
    ]);
    expect((await post('execute', request)).status).toBe(409);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('Docker failure is HTTP 503, durable rejected audit, and no grant replay', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('fixture Docker failure with private values'));
    const issued = await post('authorize', approval());
    expect(issued.status).toBe(201);
    const grant = (await issued.json()) as { grantToken: string };
    const request = execution(grant.grantToken);
    const failed = await post('execute', request);
    expect(failed.status).toBe(503);
    const rejected = await post('history', { operatorSecret: SECRET });
    expect(rejected.status).toBe(201);
    expect(await rejected.json()).toMatchObject({
      total: 1,
      items: [{ status: 'failed' }],
    });
    expect((await post('execute', request)).status).toBe(409);
    const journal = await readFile(join(base, 'isolated-audit', 'audit.jsonl'), 'utf8');
    expect(journal).toContain('"event":"rejected"');
    expect(journal).not.toContain('"event":"passed"');
    expect(journal).not.toContain('private values');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});
