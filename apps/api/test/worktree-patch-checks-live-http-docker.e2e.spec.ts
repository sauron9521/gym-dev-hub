/**
 * Manual-only REAL HTTP -> actual one-file Git patch/review -> pinned Docker
 * -> fsynced audit acceptance probe. All writes are confined to freshly
 * created fixture Git worktree and private fixture journals.
 *
 * The real controller, patch preflight/apply/review, full Git integrity,
 * check grants, source/store staging, Docker and audit are production code.
 * Only WorktreePlanService's plan discovery and boundary preflight are
 * synthetic. This is NOT a real operator production acceptance run.
 *
 * Never execute in pnpm check or CI. Never use running production audit.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { WorktreePlan } from '@gym-dev-hub/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorktreePlanController } from '../src/worktree/worktree-plan.controller.js';
import { WorktreeIntegrityService } from '../src/worktree/worktree-integrity.service.js';
import { WorktreePatchPreflightService } from '../src/worktree/worktree-patch-preflight.service.js';
import { WorktreePatchApplyService } from '../src/worktree/worktree-patch-apply.service.js';
import { WorktreePatchReviewService } from '../src/worktree/worktree-patch-review.service.js';
import { WorktreePatchChecksService } from '../src/worktree/worktree-patch-checks.service.js';

const APPROVAL = 'I_APPROVE_ISOLATED_REAL_HTTP_DOCKER_PROBE';
const ENABLED = process.env.DEV_HUB_LIVE_HTTP_DOCKER_PROBE === APPROVAL;
const ROOT = resolve(import.meta.dirname, '../../..');
const FILE = 'apps/web/src/app/page.tsx';
const SECOND = 'apps/web/src/app/layout.tsx';
const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const safeGit = (name: string, args: string[], input?: Buffer) => {
  const res = spawnSync(name, args, {
    cwd: ROOT,
    input,
    encoding: null,
    timeout: 35_000,
    maxBuffer: 120 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
    },
  });
  if (res.error || res.status !== 0 || !Buffer.isBuffer(res.stdout)) {
    throw new Error('Fixture Git preparation failed (no raw command output)');
  }
  return res.stdout;
};

describe.skipIf(!ENABLED)(
  'MANUAL REAL post-apply Git review + HTTP + pinned Docker + private audit',
  () => {
    let app: INestApplication | undefined;
    let temp = '';
    let source = '';
    let worktree = '';
    let baseUrl = '';
    let commit = '';
    let sourceHash = '';
    let postHash = '';
    let patch = '';
    let applyGrantId = '';
    let operatorSecret = '';
    let reviewSecret = '';
    let preflightSecret = '';
    let fileCount = 0;
    let totalBytes = 0;
    let plan: WorktreePlan;
    const previous = new Map<string, string | undefined>();
    const variables = [
      'DEV_HUB_PATCH_APPLY_STATE_DIR',
      'DEV_HUB_PATCH_CHECK_STATE_DIR',
      'DEV_HUB_ENABLE_PATCH_CHECKS',
      'DEV_HUB_PATCH_CHECK_OPERATOR_SECRET',
      'DEV_HUB_ENABLE_PATCH_REVIEW',
      'DEV_HUB_PATCH_APPLY_OPERATOR_SECRET',
      'DEV_HUB_ENABLE_PATCH_APPLY',
      'DEV_HUB_ENABLE_PATCH_PREFLIGHT',
      'DEV_HUB_ENABLE_SCOPED_CODE_READ',
      'DEV_HUB_ENABLE_WORKTREE_MOUNT',
      'DEV_HUB_WORKTREE_OPERATOR_SECRET',
    ] as const;

    const proposal = () => ({
      fingerprint: FINGERPRINT,
      sourceCommit: commit,
      filePath: FILE,
      expectedSourceSha256: sourceHash,
      patch,
    });
    const reviewed = () => ({
      grantId: applyGrantId,
      fingerprint: FINGERPRINT,
      sourceCommit: commit,
      filePath: FILE,
      sourceSha256: sourceHash,
      proposedSha256: postHash,
    });

    async function startHttp() {
      // Only plan discovery/inspection and Docker boundary preflight are fixture
      // providers; patch apply/review, full Git checks and Docker are real.
      const plans = {
        list: async () => [plan],
        availableForMountProbe: async () => plan,
      };
      const inspection = {
        inspect: async () => ({
          targetExists: true,
          findings: ['У worktree вже є файли: потрібна ручна перевірка.'],
        }),
      };
      const integrity = new WorktreeIntegrityService(plans as never, inspection as never);
      const preflight = new WorktreePatchPreflightService(plans as never, integrity);
      const apply = new WorktreePatchApplyService(plans as never, preflight);
      const review = new WorktreePatchReviewService(plans as never, integrity);
      const boundary = {
        status: () => ({ state: 'passed', checkedAt: new Date().toISOString() }),
      };
      const checks = new WorktreePatchChecksService(plans as never, review, boundary as never);
      @Module({ controllers: [WorktreePlanController] })
      class FixtureHttpModule {}
      app = await NestFactory.create(FixtureHttpModule, { logger: false });
      const controller = app.get(WorktreePlanController) as unknown as {
        patchPreflight: WorktreePatchPreflightService;
        patchApply: WorktreePatchApplyService;
        patchReview: WorktreePatchReviewService;
        patchChecks: WorktreePatchChecksService;
      };
      controller.patchPreflight = preflight;
      controller.patchApply = apply;
      controller.patchReview = review;
      controller.patchChecks = checks;
      await app.listen(0, '127.0.0.1');
      baseUrl =
        (await app.getUrl()) + `/workspace/sessions/${SESSION}/worktree-plans/${PLAN}/patch-`;
    }

    async function post(name: string, body: unknown): Promise<Response> {
      return fetch(baseUrl + name, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(240_000),
      });
    }

    beforeAll(async () => {
      if (process.platform !== 'linux' || process.getuid?.() === 0)
        throw new Error('Manual Docker probe requires non-root Linux');
      if (
        !/^sha256:[a-f0-9]{64}$/.test(process.env.DEV_HUB_PATCH_CHECK_IMAGE_ID ?? '') ||
        !process.env.DEV_HUB_PATCH_CHECK_PNPM_STORE
      )
        throw new Error('Requires a pinned Docker image and verified private store');
      const origin = safeGit('git', ['remote', 'get-url', 'origin']).toString('utf8').trim();
      if (
        ![
          'git@github.com:sauron9521/gym-dev-hub.git',
          'https://github.com/sauron9521/gym-dev-hub.git',
        ].includes(origin)
      )
        throw new Error('Untrusted fixture source repository');
      const selected = safeGit('git', ['rev-parse', 'HEAD']).toString('utf8').trim();
      if (!/^[a-f0-9]{40}$/.test(selected)) throw new Error('Unexpected source commit');
      for (const key of variables) previous.set(key, process.env[key]);

      temp = await mkdtemp(join(tmpdir(), 'gym-dev-hub-http-git-docker-'));
      await chmod(temp, 0o711); // Docker UID 65534 can traverse staged public files
      source = join(temp, 'source');
      worktree = join(temp, 'reviewed-worktree');
      await mkdir(source, { mode: 0o700 });

      // Only Git-tracked committed public Hub bytes; no .env or working copy.
      const archive = safeGit('git', ['archive', '--format=tar', selected]);
      safeGit('tar', ['--extract', '--file', '-', '--directory', source], archive);
      safeGit('git', ['-C', source, 'init', '-q', '-b', 'main']);
      safeGit('git', ['-C', source, 'add', '-f', '-A']);
      safeGit('git', [
        '-C',
        source,
        '-c',
        'user.name=Dev Hub Integration Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'committed public source fixture',
      ]);
      commit = safeGit('git', ['-C', source, 'rev-parse', 'HEAD']).toString('utf8').trim();
      const tree = safeGit('git', ['-C', source, 'ls-tree', '-r', '-l', '-z', 'HEAD'])
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
      fileCount = tree.length;
      totalBytes = tree.reduce((sum, entry) => {
        const match = /^100(?:644|755) blob [a-f0-9]{40,64} +([0-9]+)\t/.exec(entry);
        if (!match) throw new Error('Unexpected fixture Git tree entry');
        return sum + Number(match[1]);
      }, 0);
      if (fileCount < 50 || fileCount > 5_000 || totalBytes > 100 * 1024 * 1024)
        throw new Error('Unexpected source fixture bounds');
      safeGit('git', [
        '-C',
        source,
        'worktree',
        'add',
        '-q',
        '-b',
        'devhub/test-reviewed-operator',
        worktree,
        commit,
      ]);

      const before = await readFile(join(worktree, FILE), 'utf8');
      const originalLine = '  const params = await searchParams;';
      if (before.split(originalLine).length !== 2)
        throw new Error('Reviewed fixture must have a unique safe edit location');
      const modifiedLine = originalLine + ' // isolated one-file Git review proof';
      const lineno = before.slice(0, before.indexOf(originalLine)).split('\n').length;
      patch = `--- a/${FILE}\n+++ b/${FILE}\n@@ -${lineno} +${lineno} @@\n-${originalLine}\n+${modifiedLine}`;
      sourceHash = sha(before);
      postHash = sha(before.replace(originalLine, modifiedLine));
      // Do not modify the worktree manually: WorktreePatchApplyService will
      // perform the only approved atomic source mutation, and fsync its audit.
      operatorSecret = randomBytes(32).toString('hex');
      reviewSecret = randomBytes(32).toString('hex');
      preflightSecret = randomBytes(32).toString('hex');
      process.env.DEV_HUB_PATCH_APPLY_STATE_DIR = join(temp, 'fixture-apply-audit');
      process.env.DEV_HUB_PATCH_CHECK_STATE_DIR = join(temp, 'fixture-check-audit');
      process.env.DEV_HUB_ENABLE_PATCH_CHECKS = 'true';
      process.env.DEV_HUB_PATCH_CHECK_OPERATOR_SECRET = operatorSecret;
      process.env.DEV_HUB_ENABLE_PATCH_REVIEW = 'true';
      process.env.DEV_HUB_PATCH_APPLY_OPERATOR_SECRET = reviewSecret;
      process.env.DEV_HUB_ENABLE_PATCH_APPLY = 'true';
      process.env.DEV_HUB_ENABLE_PATCH_PREFLIGHT = 'true';
      process.env.DEV_HUB_ENABLE_SCOPED_CODE_READ = 'true';
      process.env.DEV_HUB_ENABLE_WORKTREE_MOUNT = 'true';
      process.env.DEV_HUB_WORKTREE_OPERATOR_SECRET = preflightSecret;
      plan = {
        id: PLAN,
        sessionId: SESSION,
        repository: 'sauron9521/gym-dev-hub',
        sourcePath: source,
        targetPath: worktree,
        proposedBranch: 'devhub/test-reviewed-operator',
        fingerprint: FINGERPRINT,
        state: 'created',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        history: [],
        executionEnabled: false,
        worktreeCreated: true,
        hydrationState: 'completed',
        hydrationFiles: fileCount,
        hydrationBytes: totalBytes,
        baseHeadSha: commit,
      };
      await startHttp();
    });

    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        for (const key of variables) {
          const original = previous.get(key);
          if (original === undefined) delete process.env[key];
          else process.env[key] = original;
        }
        if (temp && temp.startsWith(join(tmpdir(), 'gym-dev-hub-http-git-docker-'))) {
          const stat = await lstat(temp);
          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            await rm(temp, { recursive: true, force: false });
          }
        }
      }
    });

    it('performs real one-file HTTP patch apply+Git review then Docker and durable audit', async () => {
      const preflight = await post('preflight', {
        ...proposal(),
        operatorSecret: preflightSecret,
      });
      expect(preflight.status).toBe(201);
      expect(await preflight.json()).toMatchObject({
        sourceCommit: commit,
        sourceSha256: sourceHash,
        proposedSha256: postHash,
        integrity: 'verified',
      });

      const permit = await post('apply-authorize', {
        ...proposal(),
        confirmation: 'I_APPROVE_ONE_FILE_PATCH_ONLY',
        operatorSecret: reviewSecret,
      });
      expect(permit.status).toBe(201);
      const applyGrant = (await permit.json()) as { grantId: string; grantToken: string };
      expect(applyGrant.grantToken).toHaveLength(43);
      applyGrantId = applyGrant.grantId;
      const applied = await post('apply', {
        ...proposal(),
        operatorSecret: reviewSecret,
        grantToken: applyGrant.grantToken,
      });
      expect(applied.status).toBe(201);
      expect(await applied.json()).toMatchObject({
        status: 'applied',
        grantId: applyGrantId,
        proposedSha256: postHash,
      });
      expect(sha(await readFile(join(worktree, FILE)))).toBe(postHash);
      expect(
        (
          await post('apply', {
            ...proposal(),
            operatorSecret: reviewSecret,
            grantToken: applyGrant.grantToken,
          })
        ).status,
      ).toBe(409);

      // Actual Git verifier rejects additional modified tracked files.
      const secondPath = join(worktree, SECOND);
      const originalSecond = await readFile(secondPath, 'utf8');
      await writeFile(secondPath, originalSecond + '\n// second unexpected file\n');
      const dirty = await post('review', {
        ...reviewed(),
        operatorSecret: reviewSecret,
      });
      expect(dirty.status).toBe(409);
      await writeFile(secondPath, originalSecond);

      const verified = await post('review', {
        ...reviewed(),
        operatorSecret: reviewSecret,
      });
      expect(verified.status).toBe(201);
      expect(await verified.json()).toMatchObject({
        status: 'verified',
        changedFiles: 1,
        filePath: FILE,
        proposedSha256: postHash,
      });

      const badSecret = await post('check-authorize', {
        ...reviewed(),
        recipeId: 'WEB_FORMAT',
        confirmation: 'I_APPROVE_ONE_FIXED_DOCKER_CHECK',
        reviewOperatorSecret: reviewSecret,
        operatorSecret: 'x'.repeat(64),
      });
      expect(badSecret.status).toBe(403);

      const auth = await post('check-authorize', {
        ...reviewed(),
        recipeId: 'WEB_FORMAT',
        confirmation: 'I_APPROVE_ONE_FIXED_DOCKER_CHECK',
        reviewOperatorSecret: reviewSecret,
        operatorSecret,
      });
      expect(auth.status).toBe(201);
      const dockerGrant = (await auth.json()) as {
        grantId: string;
        grantToken: string;
        purpose: string;
      };
      expect(dockerGrant).toMatchObject({
        purpose: 'AUTHORIZE_ONE_FIXED_POST_APPLY_DOCKER_CHECK',
      });
      const runId = randomUUID();
      const request = {
        ...reviewed(),
        recipeId: 'WEB_FORMAT',
        runId,
        grantToken: dockerGrant.grantToken,
        reviewOperatorSecret: reviewSecret,
        operatorSecret,
      };
      const result = await post('check-execute', request);
      expect(result.status).toBe(201);
      expect(await result.json()).toMatchObject({
        status: 'passed',
        runId,
        grantId: dockerGrant.grantId,
        recipeId: 'WEB_FORMAT',
        sourceCommit: commit,
        proposedSha256: postHash,
        readOnlySource: true,
        networkEnabled: false,
        containerRemoved: true,
        arbitraryCommandsEnabled: false,
      });

      expect((await post('check-execute', request)).status).toBe(409);
      const history = await post('check-history', { operatorSecret });
      expect(history.status).toBe(201);
      expect(await history.json()).toMatchObject({
        total: 1,
        items: [{ status: 'passed', runId, grantId: dockerGrant.grantId }],
      });
      const appliedJournal = await readFile(
        join(temp, 'fixture-apply-audit', 'audit.jsonl'),
        'utf8',
      );
      const checkedJournal = await readFile(
        join(temp, 'fixture-check-audit', 'audit.jsonl'),
        'utf8',
      );
      expect(appliedJournal).toContain('"event":"applied"');
      expect(checkedJournal).toContain('"event":"passed"');
      for (const secret of [
        operatorSecret,
        reviewSecret,
        preflightSecret,
        applyGrant.grantToken,
        dockerGrant.grantToken,
        FILE,
        patch,
      ]) {
        expect(appliedJournal + checkedJournal).not.toContain(secret);
      }

      // New Nest app instance, same fixture journals and reviewed worktree:
      // no in-memory grants survive and no Docker check is replayed.
      await app?.close();
      app = undefined;
      await startHttp();
      const persisted = await post('check-history', { operatorSecret });
      expect(persisted.status).toBe(201);
      expect(await persisted.json()).toMatchObject({
        total: 1,
        items: [{ status: 'passed', runId }],
      });
      expect((await post('check-execute', request)).status).toBe(409);
      process.stdout.write(
        'ISOLATED_REVIEWED_GIT_HTTP_DOCKER_PASSED; production grants not used\n',
      );
    }, 300_000);
  },
);
