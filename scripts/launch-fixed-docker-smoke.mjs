/**
 * Opt-in real Linux Docker checks with an isolated TEST-ONLY audit journal.
 * This does not authorize any Hub workflow grant or write production receipts.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'apps/web/src/app/page.tsx';
const RECIPES = ['WEB_FORMAT', 'WEB_TYPECHECK', 'WEB_TEST'];
let currentRecipe = 'PRECHECK';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function checked(binary, args, options = {}) {
  const p = spawnSync(binary, args, {
    cwd: ROOT,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    input: options.input,
    timeout: 30_000,
    maxBuffer: 120 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (p.status !== 0 || p.error) throw new Error('Smoke fixture preparation failed (redacted)');
  return p.stdout;
}

export function validateSmokeCli(argv, env, platform, uid) {
  if (argv.length !== 1 || argv[0] !== '--confirm-isolated-docker-smoke')
    throw new Error('Requires --confirm-isolated-docker-smoke; never runs automatically');
  if (platform !== 'linux' || uid === 0) throw new Error('Requires non-root Linux operator');
  if (
    !/^sha256:[a-f0-9]{64}$/.test(env.DEV_HUB_PATCH_CHECK_IMAGE_ID ?? '') ||
    !env.DEV_HUB_PATCH_CHECK_PNPM_STORE
  )
    throw new Error('Missing pinned runner image ID or verified offline store');
  for (const key of ['DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])
    if (env[key] && (key !== 'DOCKER_CONTEXT' || env[key] !== 'default'))
      throw new Error('Remote Docker configuration rejected');
  if (env.DOCKER_HOST && env.DOCKER_HOST !== 'unix:///var/run/docker.sock')
    throw new Error('Remote Docker configuration rejected');
}

export async function main(argv = process.argv.slice(2)) {
  validateSmokeCli(argv, process.env, process.platform, process.getuid?.());
  const origin = checked('git', ['remote', 'get-url', 'origin']).trim();
  if (
    ![
      'git@github.com:sauron9521/gym-dev-hub.git',
      'https://github.com/sauron9521/gym-dev-hub.git',
    ].includes(origin)
  )
    throw new Error('Unexpected source repository');
  const endpoint = checked('docker', [
    'context',
    'inspect',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]).trim();
  let socket;
  try {
    socket = await lstat('/var/run/docker.sock');
  } catch {
    throw new Error('Local Docker socket unavailable');
  }
  if (
    endpoint !== 'unix:///var/run/docker.sock' ||
    !socket.isSocket() ||
    (socket.mode & 0o007) !== 0
  )
    throw new Error('Untrusted Docker endpoint for smoke');
  const commit = checked('git', ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid pinned source commit');
  const temp = await mkdtemp(join(tmpdir(), 'gym-dev-hub-fixed-docker-smoke-'));
  try {
    // Docker UID 65534 may traverse to the public-only staged source;
    // original archive and audit remain 0700 inside this unlisted directory.
    await chmod(temp, 0o711);
    const checkout = join(temp, 'source');
    const journal = join(temp, 'journal');
    await mkdir(checkout, { mode: 0o700 });
    process.env.DEV_HUB_PATCH_CHECK_STATE_DIR = journal;

    // Archive only the pinned tracked Git tree: never mount host node_modules,
    // ignored .env, .local, other worktrees or developer uncommitted files.
    const archive = checked('git', ['archive', '--format=tar', commit], { encoding: null });
    checked('tar', ['--extract', '--file', '-', '--directory', checkout], {
      input: archive,
      encoding: 'utf8',
    });
    const fileHash = sha256(await readFile(join(checkout, FILE)));

    // The trusted provisioner retains its private 0700/0600 store. Never chmod
    // that original. Copy only verified public dependency content into a
    // disposable Docker-readable mirror, accessible only for this smoke.
    const originalStore = resolve(process.env.DEV_HUB_PATCH_CHECK_PNPM_STORE);
    const storeName = originalStore.split('/').at(-1);
    if (!/^[a-f0-9]{64}$/.test(storeName ?? ''))
      throw new Error('Pinned store must use a deterministic key');
    const storeParent = join(temp, 'public-store');
    const storeMirror = join(storeParent, storeName);
    await mkdir(storeParent, { mode: 0o755 });
    const skipProjects = join(originalStore, 'v11', 'projects');
    await cp(originalStore, storeMirror, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      filter: async (source) => {
        if (source === skipProjects || source.startsWith(skipProjects + '/')) return false;
        const info = await lstat(source);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
          throw new Error('Untrusted store entry type');
        return true;
      },
    });
    checked('chmod', ['-R', 'u=rwX,go=rX', storeMirror]);
    await copyFile(originalStore + '.json', storeMirror + '.json');
    await chmod(storeMirror + '.json', 0o600);
    process.env.DEV_HUB_PATCH_CHECK_PNPM_STORE = storeMirror;

    const [
      { preparePatchCheckRunner, runPatchChecksDocker },
      { withPatchCheckSourceStage },
      { appendPatchCheckAudit, readPatchCheckAudit, projectPatchCheckHistory },
    ] = await Promise.all([
      import('../apps/api/dist/worktree/worktree-patch-checks-docker.js'),
      import('../apps/api/dist/worktree/worktree-patch-check-stage.js'),
      import('../apps/api/dist/worktree/worktree-patch-check-audit.js'),
    ]);
    const sessionId = randomUUID();
    const planId = randomUUID();
    const completed = [];
    for (const recipeId of RECIPES) {
      currentRecipe = recipeId;
      const grant = {
        id: randomUUID(),
        sessionId,
        planId,
        recipeId,
        filePath: FILE,
        sourceCommit: commit,
        sourceSha256: fileHash,
        proposedSha256: fileHash,
        fingerprint: 'sha256:' + sha256(recipeId + commit),
      };
      const runId = randomUUID();
      await appendPatchCheckAudit('issued', grant);
      await appendPatchCheckAudit('attempted', grant, runId);
      const started = Date.now();
      const receipt = await withPatchCheckSourceStage(checkout, async (stagePath) => {
        const prepared = await preparePatchCheckRunner(stagePath);
        return runPatchChecksDocker(
          prepared,
          recipeId,
          FILE,
          fileHash,
          new AbortController().signal,
        );
      });
      await appendPatchCheckAudit('passed', grant, runId, {
        durationMs: Date.now() - started,
        stdoutBytes: receipt.stdoutBytes,
        stderrBytes: receipt.stderrBytes,
        containerRemoved: receipt.containerRemoved,
      });
      const history = projectPatchCheckHistory(
        await readPatchCheckAudit(),
        sessionId,
        planId,
        null,
        new Set(),
      );
      const entry = history.items.find((item) => item.grantId === grant.id);
      if (entry?.status !== 'passed' || !receipt.containerRemoved)
        throw new Error('Real Docker success was not durable in the test-only journal');
      completed.push(recipeId);
      process.stdout.write('FIXED_RECIPE_PASSED ' + recipeId + '\n');
    }

    // Simulate an interrupted audit after process loss in TEST-ONLY journal;
    // never kill production API, overwrite its audit, or fake a success.
    const interrupted = {
      id: randomUUID(),
      sessionId,
      planId,
      recipeId: 'WEB_TEST',
      filePath: FILE,
      sourceCommit: commit,
      sourceSha256: fileHash,
      proposedSha256: fileHash,
      fingerprint: 'sha256:' + sha256('incomplete-' + commit),
    };
    await appendPatchCheckAudit('issued', interrupted);
    await appendPatchCheckAudit('attempted', interrupted, randomUUID());
    const history = projectPatchCheckHistory(
      await readPatchCheckAudit(),
      sessionId,
      planId,
      null,
      new Set(),
    );
    if (history.items.find((item) => item.grantId === interrupted.id)?.status !== 'interrupted')
      throw new Error('Unfinished test-only audit was incorrectly marked successful');
    process.stdout.write(
      JSON.stringify({
        status: 'isolated-real-docker-fixture-verified',
        sourceCommit: commit,
        recipesPassed: completed,
        temporaryAuditOnly: true,
        interruptedProjection: 'interrupted',
        productionGrantsUsed: false,
        productionAuditWritten: false,
      }) + '\n',
    );
  } finally {
    // Only the freshly created temporary directory belongs to this script.
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const reason = String(error?.message ?? '');
    const stage =
      /^Fixed Docker check rejected at stage: (?:ARGUMENTS|STAGING|STORE_STAGE|OFFLINE_INSTALL|FIXED_FORMAT|CONTRACTS_BUILD|FIXED_CHECK|RECEIPT|INTERRUPTED_OR_LIMIT|UNKNOWN)$/.test(
        reason,
      )
        ? reason.slice('Fixed Docker check rejected at stage: '.length)
        : 'UNKNOWN';
    process.stderr.write(
      'ISOLATED_DOCKER_SMOKE_FAILED: recipe=' +
        currentRecipe +
        ' stage=' +
        stage +
        '; no secrets logged\n',
    );
    process.exitCode = 1;
  });
}
