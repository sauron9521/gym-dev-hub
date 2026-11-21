/**
 * Manual-only, opt-in REAL HTTP -> pinned Docker -> fsynced audit acceptance probe.
 *
 * The controller, check service, source/store staging, Docker and audit are
 * production code. Plan + review + boundary are explicitly fixture-only;
 * this MUST NOT be described as owner-authorized production acceptance.
 *
 * Never run as part of pnpm check or CI. Never use production audit or grant.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorktreePlanController } from '../src/worktree/worktree-plan.controller.js';
import { WorktreePatchChecksService } from '../src/worktree/worktree-patch-checks.service.js';

const APPROVAL = 'I_APPROVE_ISOLATED_REAL_HTTP_DOCKER_PROBE';
const ENABLED = process.env.DEV_HUB_LIVE_HTTP_DOCKER_PROBE === APPROVAL;
const ROOT = resolve(import.meta.dirname, '../../..');
const FILE = 'apps/web/src/app/page.tsx';
const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const REVIEW_GRANT = '00000000-0000-4000-8000-000000000777';
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function run(binary: string, args: string[], input?: Buffer): Buffer {
  const processResult = spawnSync(binary, args, {
    cwd: ROOT,
    input,
    encoding: null,
    timeout: 35_000,
    maxBuffer: 120 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (processResult.error || processResult.status !== 0 || !Buffer.isBuffer(processResult.stdout)) {
    throw new Error('Verified source archive preparation failed');
  }
  return processResult.stdout;
}

describe.skipIf(!ENABLED)(
  'MANUAL real localhost HTTP -> non-networked Docker -> private audit',
  () => {
    let app: INestApplication | undefined;
    let source = '';
    let temp = '';
    let baseUrl = '';
    let gitCommit = '';
    let sourceHash = '';
    let operatorSecret = '';
    let reviewSecret = '';
    const oldEnv = new Map<string, string | undefined>();
    const vars = [
      'DEV_HUB_PATCH_CHECK_STATE_DIR',
      'DEV_HUB_ENABLE_PATCH_CHECKS',
      'DEV_HUB_PATCH_CHECK_OPERATOR_SECRET',
    ];

    const check = () => ({
      grantId: REVIEW_GRANT,
      fingerprint: FINGERPRINT,
      sourceCommit: gitCommit,
      filePath: FILE,
      sourceSha256: sourceHash,
      proposedSha256: sourceHash,
      recipeId: 'WEB_FORMAT',
    });

    async function startHttp() {
      // These 3 providers are conservative, explicitly fake reviewed-source /
      // boundary preconditions: a real operator still must review actual Git diff.
      const plans = {
        list: async () => [{ id: PLAN, repository: 'sauron9521/gym-dev-hub' }],
        availableForMountProbe: async () => ({
          repository: 'sauron9521/gym-dev-hub',
          fingerprint: FINGERPRINT,
          baseHeadSha: gitCommit,
          targetPath: source,
        }),
      };
      const review = {
        review: async () => ({
          status: 'verified',
          changedFiles: 1,
          sourceCommit: gitCommit,
          proposedSha256: sourceHash,
          filePath: FILE,
        }),
      };
      const boundary = {
        status: () => ({ state: 'passed', checkedAt: new Date().toISOString() }),
      };
      const actual = new WorktreePatchChecksService(
        plans as never,
        review as never,
        boundary as never,
      );
      @Module({ controllers: [WorktreePlanController] })
      class IsolatedHttpModule {}
      app = await NestFactory.create(IsolatedHttpModule, { logger: false });
      (
        app.get(WorktreePlanController) as unknown as {
          patchChecks: WorktreePatchChecksService;
        }
      ).patchChecks = actual;
      await app.listen(0, '127.0.0.1');
      baseUrl =
        (await app.getUrl()) + `/workspace/sessions/${SESSION}/worktree-plans/${PLAN}/patch-check-`;
    }

    async function post(kind: string, body: unknown): Promise<Response> {
      return fetch(baseUrl + kind, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(180_000),
      });
    }

    beforeAll(async () => {
      if (process.platform !== 'linux' || process.getuid?.() === 0)
        throw new Error('Manual Docker HTTP probe requires non-root Linux operator');
      if (
        !/^sha256:[a-f0-9]{64}$/.test(process.env.DEV_HUB_PATCH_CHECK_IMAGE_ID ?? '') ||
        !process.env.DEV_HUB_PATCH_CHECK_PNPM_STORE
      )
        throw new Error('Missing pinned Docker image or trusted offline pnpm store');
      for (const key of vars) oldEnv.set(key, process.env[key]);
      gitCommit = run('git', ['rev-parse', 'HEAD']).toString('utf8').trim();
      if (!/^[a-f0-9]{40}$/.test(gitCommit)) throw new Error('Invalid pinned Git commit');
      const origin = run('git', ['remote', 'get-url', 'origin']).toString('utf8').trim();
      if (
        ![
          'git@github.com:sauron9521/gym-dev-hub.git',
          'https://github.com/sauron9521/gym-dev-hub.git',
        ].includes(origin)
      )
        throw new Error('Unexpected source repository');

      temp = await mkdtemp(join(tmpdir(), 'gym-dev-hub-http-docker-probe-'));
      await chmod(temp, 0o711); // Docker UID 65534 can traverse public-only snapshot
      source = join(temp, 'source');
      await mkdir(source, { mode: 0o700 });
      const tarball = run('git', ['archive', '--format=tar', gitCommit]);
      run('tar', ['--extract', '--file', '-', '--directory', source], tarball);
      sourceHash = sha(await readFile(join(source, FILE)));
      operatorSecret = randomBytes(32).toString('hex');
      reviewSecret = randomBytes(32).toString('hex');
      process.env.DEV_HUB_PATCH_CHECK_STATE_DIR = join(temp, 'isolated-audit');
      process.env.DEV_HUB_ENABLE_PATCH_CHECKS = 'true';
      process.env.DEV_HUB_PATCH_CHECK_OPERATOR_SECRET = operatorSecret;
      await startHttp();
    });

    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        for (const key of vars) {
          const before = oldEnv.get(key);
          if (before === undefined) delete process.env[key];
          else process.env[key] = before;
        }
        if (temp && temp.startsWith(join(tmpdir(), 'gym-dev-hub-http-docker-probe-'))) {
          const stat = await lstat(temp);
          if (stat.isDirectory() && !stat.isSymbolicLink())
            await rm(temp, { recursive: true, force: false });
        }
      }
    });

    it('consumes a one-time HTTP grant, performs REAL fixed Docker, persists sanitized receipt and never replays', async () => {
      const missing = await post('authorize', {
        ...check(),
        confirmation: 'I_APPROVE_ONE_FIXED_DOCKER_CHECK',
        reviewOperatorSecret: reviewSecret,
        operatorSecret: 'x'.repeat(64),
      });
      expect(missing.status).toBe(403);

      const response = await post('authorize', {
        ...check(),
        confirmation: 'I_APPROVE_ONE_FIXED_DOCKER_CHECK',
        reviewOperatorSecret: reviewSecret,
        operatorSecret,
      });
      expect(response.status).toBe(201);
      const grant = (await response.json()) as {
        grantId: string;
        grantToken: string;
        purpose: string;
      };
      expect(grant).toMatchObject({ purpose: 'AUTHORIZE_ONE_FIXED_POST_APPLY_DOCKER_CHECK' });
      expect(grant.grantToken).toHaveLength(43);

      const runId = randomUUID();
      const executeBody = {
        ...check(),
        runId,
        grantToken: grant.grantToken,
        reviewOperatorSecret: reviewSecret,
        operatorSecret,
      };
      const execution = await post('execute', executeBody);
      expect(execution.status).toBe(201);
      expect(await execution.json()).toMatchObject({
        status: 'passed',
        runId,
        grantId: grant.grantId,
        recipeId: 'WEB_FORMAT',
        networkEnabled: false,
        readOnlySource: true,
        containerRemoved: true,
        arbitraryCommandsEnabled: false,
      });

      const history = await post('history', { operatorSecret });
      expect(history.status).toBe(201);
      expect(await history.json()).toMatchObject({
        total: 1,
        readOnly: true,
        rawLogsAvailable: false,
        items: [{ status: 'passed', runId, grantId: grant.grantId }],
      });
      expect((await post('execute', executeBody)).status).toBe(409);

      const journal = await readFile(join(temp, 'isolated-audit', 'audit.jsonl'), 'utf8');
      expect(journal).toContain('"event":"issued"');
      expect(journal).toContain('"event":"attempted"');
      expect(journal).toContain('"event":"passed"');
      for (const secret of [operatorSecret, reviewSecret, grant.grantToken, FILE]) {
        expect(journal).not.toContain(secret);
      }

      await app?.close();
      app = undefined;
      await startHttp();
      const persisted = await post('history', { operatorSecret });
      expect(persisted.status).toBe(201);
      expect(await persisted.json()).toMatchObject({
        total: 1,
        items: [{ status: 'passed', runId }],
      });
      expect((await post('execute', executeBody)).status).toBe(409);
      process.stdout.write(
        'ISOLATED_REAL_HTTP_DOCKER_AUDIT_PASSED: WEB_FORMAT; no live operator grants\n',
      );
    }, 240_000);
  },
);
