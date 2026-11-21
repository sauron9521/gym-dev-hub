/**
 * Internal child process of the explicitly opted-in SIGKILL probe.
 * Never call independently: strict parent-created fixture environment only.
 */
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { NestFactory } = requireApi('@nestjs/core');
const { Module } = requireApi('@nestjs/common');
import { WorktreePlanController } from '../apps/api/dist/worktree/worktree-plan.controller.js';
import { WorktreePatchChecksService } from '../apps/api/dist/worktree/worktree-patch-checks.service.js';
import { readPatchCheckAudit } from '../apps/api/dist/worktree/worktree-patch-check-audit.js';

const SESSION = '00000000-0000-4000-8000-000000000456';
const PLAN = '00000000-0000-4000-8000-000000000123';
const REVIEW_GRANT = '00000000-0000-4000-8000-000000000777';
const FINGERPRINT = 'sha256:' + 'b'.repeat(64);
const FILE = 'apps/web/src/app/page.tsx';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function checkedFixture() {
  const root = process.env.DEV_HUB_SIGKILL_FIXTURE_DIR;
  if (
    !root ||
    !/^\/tmp\/gym-dev-hub-sigkill-[A-Za-z0-9_-]+$/.test(root) ||
    (await realpath(root)) !== root
  )
    throw new Error('Invalid test-only fixture root');
  const state = await lstat(root);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.uid !== process.getuid() ||
    (state.mode & 0o066) !== 0
  )
    throw new Error('Untrusted fixture root permissions');
  if (
    process.env.DEV_HUB_PATCH_CHECK_STATE_DIR !== join(root, 'audit') ||
    !/^sha256:[a-f0-9]{64}$/.test(process.env.DEV_HUB_PATCH_CHECK_IMAGE_ID ?? '') ||
    !process.env.DEV_HUB_PATCH_CHECK_PNPM_STORE
  )
    throw new Error('Invalid isolated audit or pinned Docker configuration');
  const image = await readFile(join(root, 'source', FILE));
  const commit = (await readFile(join(root, 'commit'), 'utf8')).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid fixture source commit');
  return { root, fileHash: hash(image), commit };
}
function checkedSecrets() {
  const secret = process.env.DEV_HUB_PATCH_CHECK_OPERATOR_SECRET;
  const reviewSecret = process.env.DEV_HUB_SIGKILL_REVIEW_SECRET;
  if (!secret || !reviewSecret || secret.length < 32 || reviewSecret.length < 32)
    throw new Error('Independent ephemeral check/review credentials unavailable');
  return { secret, reviewSecret };
}

async function server(fixture) {
  const plan = {
    repository: 'sauron9521/gym-dev-hub',
    fingerprint: FINGERPRINT,
    baseHeadSha: fixture.commit,
    targetPath: join(fixture.root, 'source'),
    id: PLAN,
  };
  const plans = {
    list: async () => [plan],
    availableForMountProbe: async () => plan,
  };
  const review = {
    review: async () => ({
      status: 'verified',
      changedFiles: 1,
      sourceCommit: fixture.commit,
      proposedSha256: fixture.fileHash,
      filePath: FILE,
    }),
  };
  const boundary = {
    status: () => ({ state: 'passed', checkedAt: new Date().toISOString() }),
  };
  const checks = new WorktreePatchChecksService(plans, review, boundary);
  // The published production controller still resolves all its decorated
  // constructor metadata. Supply inert, local-only placeholders for other
  // endpoints, which this fixture NEVER invokes.
  const deps = Reflect.getMetadata('design:paramtypes', WorktreePlanController) ?? [];
  const providers = deps
    .filter((type) => typeof type === 'function')
    .map((type) => ({
      provide: type,
      useValue: {},
    }));
  class IsolatedModule {}
  Module({ controllers: [WorktreePlanController], providers })(IsolatedModule);
  const app = await NestFactory.create(IsolatedModule, { logger: false });
  app.get(WorktreePlanController).patchChecks = checks;
  await app.listen(0, '127.0.0.1');
  return {
    app,
    endpoint:
      (await app.getUrl()) + `/workspace/sessions/${SESSION}/worktree-plans/${PLAN}/patch-check-`,
  };
}
async function post(endpoint, action, value) {
  return fetch(endpoint + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
    redirect: 'manual',
    signal: AbortSignal.timeout(450_000),
  });
}
async function privateReplayWrite(file, value) {
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main() {
  const phase = process.argv.slice(2);
  if (
    process.platform !== 'linux' ||
    process.getuid?.() === 0 ||
    phase.length !== 1 ||
    !['run', 'recover'].includes(phase[0]) ||
    process.env.DEV_HUB_SIGKILL_CHILD !== 'EXPLICIT_ISOLATED_WORKER'
  )
    throw new Error('Parent-only non-root Linux recovery worker');
  const fixture = await checkedFixture();
  const { secret, reviewSecret } = checkedSecrets();
  process.env.DEV_HUB_ENABLE_PATCH_CHECKS = 'true';
  const { app, endpoint } = await server(fixture);
  try {
    const check = {
      grantId: REVIEW_GRANT,
      fingerprint: FINGERPRINT,
      sourceCommit: fixture.commit,
      filePath: FILE,
      sourceSha256: fixture.fileHash,
      proposedSha256: fixture.fileHash,
      recipeId: 'WEB_TEST', // must remain running long enough for SIGKILL
    };
    if (phase[0] === 'run') {
      const issued = await post(endpoint, 'authorize', {
        ...check,
        confirmation: 'I_APPROVE_ONE_FIXED_DOCKER_CHECK',
        reviewOperatorSecret: reviewSecret,
        operatorSecret: secret,
      });
      if (issued.status !== 201) throw new Error('Cannot issue fixture one-time grant');
      const grant = await issued.json();
      const runId = randomUUID();
      const request = {
        ...check,
        runId,
        grantToken: grant.grantToken,
        reviewOperatorSecret: reviewSecret,
        operatorSecret: secret,
      };
      await privateReplayWrite(join(fixture.root, 'replay.json'), {
        ...check,
        runId,
        grantToken: grant.grantToken,
        issuedGrantId: grant.grantId,
      });
      // This request MUST be terminated by parent SIGKILL while Docker runs.
      const execution = await post(endpoint, 'execute', request);
      throw new Error('Docker fixture finished unexpectedly: HTTP ' + execution.status);
    }
    const replayPath = join(fixture.root, 'replay.json');
    const replayStat = await lstat(replayPath);
    if (
      !replayStat.isFile() ||
      replayStat.isSymbolicLink() ||
      (replayStat.mode & 0o077) !== 0 ||
      replayStat.size > 4096
    )
      throw new Error('Untrusted fixture replay record');
    const replay = JSON.parse(await readFile(replayPath, 'utf8'));
    const history = await post(endpoint, 'history', { operatorSecret: secret });
    if (history.status !== 201) throw new Error('Restarted HTTP history failed');
    const data = await history.json();
    if (
      data.total !== 1 ||
      data.items?.length !== 1 ||
      data.items[0].status !== 'interrupted' ||
      data.items[0].grantId !== replay.issuedGrantId ||
      data.items[0].runId !== replay.runId ||
      data.rawLogsAvailable !== false ||
      data.readOnly !== true
    )
      throw new Error('Interrupted receipt was incorrectly recovered');
    const again = await post(endpoint, 'execute', {
      grantId: replay.grantId,
      fingerprint: replay.fingerprint,
      sourceCommit: replay.sourceCommit,
      filePath: replay.filePath,
      sourceSha256: replay.sourceSha256,
      proposedSha256: replay.proposedSha256,
      recipeId: replay.recipeId,
      runId: replay.runId,
      grantToken: replay.grantToken,
      reviewOperatorSecret: reviewSecret,
      operatorSecret: secret,
    });
    if (again.status !== 409) throw new Error('Restart incorrectly replayed consumed grant');
    const journal = await readFile(join(fixture.root, 'audit', 'audit.jsonl'), 'utf8');
    for (const forbidden of [secret, reviewSecret, replay.grantToken, FILE]) {
      if (journal.includes(forbidden)) throw new Error('Audit leaked secret or file path');
    }
    const records = await readPatchCheckAudit();
    if (
      records.length !== 2 ||
      records[0].event !== 'issued' ||
      records[1].event !== 'attempted' ||
      records.some((entry) => entry.event === 'passed' || entry.event === 'rejected')
    )
      throw new Error('Interrupted audit has a fabricated terminal outcome');
    process.stdout.write('SIGKILL_RECOVERY_HTTP_INTERRUPTED_VERIFIED\n');
  } finally {
    await app.close();
  }
}
main().catch(() => {
  process.stderr.write('ISOLATED_SIGKILL_WORKER_REJECTED; no sensitive logs\n');
  process.exitCode = 1;
});
