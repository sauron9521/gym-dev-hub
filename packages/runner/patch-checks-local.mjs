/**
 * Fixed, opt-in, host-authorized patch check inside isolated Docker.
 * Executes reviewed compiler/test CLIs, never shell or arbitrary user argv.
 * The project itself is untrusted; its test/config code executes ONLY in
 * this disposable, networkless, unprivileged, bounded container.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const RECIPES = Object.freeze({
  API_TYPECHECK: { package: '@gym-dev-hub/api', command: 'tsc', args: ['--noEmit'] },
  API_TEST: { package: '@gym-dev-hub/api', command: 'vitest', args: ['run'] },
  WEB_TYPECHECK: { package: '@gym-dev-hub/web', command: 'tsc', args: ['--noEmit'] },
  WEB_TEST: { package: '@gym-dev-hub/web', command: 'vitest', args: ['run'] },
});
const MAX_FILES = 5_000;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT = 65_536;
const SOURCE = '/source';
const PROJECT = '/workspace/project';
const sha = (value) => createHash('sha256').update(value).digest('hex');

export function validatePatchCheckArgs(args) {
  if (args.length !== 3 || !Object.hasOwn(RECIPES, args[0])) {
    throw new Error('Unsupported fixed patch check');
  }
  const [recipeId, path, expectedSha] = args;
  if (
    path.length < 1 ||
    path.length > 160 ||
    path.includes('\\') ||
    path.split('/').some((p) => !p || p === '.' || p === '..' || p === '.git') ||
    /[\r\n\0]/.test(path) ||
    !/^[a-f0-9]{64}$/.test(expectedSha)
  ) {
    throw new Error('Unsafe approved file or SHA');
  }
  const area = recipeId.startsWith('API_') ? 'apps/api/' : 'apps/web/';
  if (!path.startsWith(area)) throw new Error('Recipe not scoped to approved package');
  return { recipeId, path, expectedSha, recipe: RECIPES[recipeId] };
}

export async function stageSourceAndVerify(source, target, filePath, shaExpected) {
  let files = 0;
  let bytes = 0;
  let sawApproved = false;
  async function walk(folder, dest, relative) {
    for (const entry of await readdir(folder)) {
      if (entry === '.git' && relative === '') continue;
      const from = join(folder, entry);
      const name = relative ? relative + '/' + entry : entry;
      const stat = await lstat(from);
      if (stat.isSymbolicLink()) throw new Error('Symlink in source tree');
      if (stat.isDirectory()) {
        await mkdir(join(dest, entry), { mode: 0o700 });
        await walk(from, join(dest, entry), name);
      } else if (stat.isFile()) {
        if (++files > MAX_FILES || (bytes += stat.size) > MAX_BYTES) {
          throw new Error('Source exceeds bounded limits');
        }
        const output = join(dest, entry);
        await copyFile(from, output);
        if (name === filePath) {
          sawApproved = true;
          if (sha(await readFile(output)) !== shaExpected) {
            throw new Error('Approved postimage hash changed');
          }
        }
      } else throw new Error('Unsupported filesystem object in source');
    }
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  await walk(source, target, '');
  if (!sawApproved) throw new Error('Approved file missing from source');
  return { files, bytes };
}

function checkedRun(binary, args, cwd, timeout) {
  const result = spawnSync(binary, args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_OUTPUT,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/workspace',
      TMPDIR: '/tmp',
      TMP: '/tmp',
      TEMP: '/tmp',
      XDG_CACHE_HOME: '/workspace/.cache',
      XDG_DATA_HOME: '/workspace/.local/share',
      CI: 'true',
      NODE_ENV: 'test',
      npm_config_update_notifier: 'false',
      PNPM_HOME: '/workspace',
    },
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error('Fixed check failed, timed out or exceeded output quota');
  }
  return {
    status: result.status,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
    stderrBytes: Buffer.byteLength(result.stderr ?? ''),
  };
}

async function main() {
  const request = validatePatchCheckArgs(process.argv.slice(2));
  const staged = await stageSourceAndVerify(SOURCE, PROJECT, request.path, request.expectedSha);
  // Never run package lifecycle scripts during installation. Store is mounted
  // read-only, network is disabled, dependencies are copied to private tmpfs.
  const install = checkedRun(
    '/usr/bin/devhub-pnpm',
    [
      'install',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--config.package-import-method=copy',
      '--store-dir=/store',
    ],
    PROJECT,
    180_000,
  );
  if (install.status !== 0) throw new Error('Offline dependency closure missing');
  // Build only the common TypeScript declaration package, from an exact Node
  // executable path. This avoids running pnpm script hooks or binaries out of
  // noexec scratch, and preserves strict command provenance.
  const contractsBuild = checkedRun(
    '/usr/bin/node',
    [join(PROJECT, 'node_modules/typescript/bin/tsc'), '-p', 'packages/contracts/tsconfig.json'],
    PROJECT,
    90_000,
  );
  if (contractsBuild.status !== 0) throw new Error('Shared contracts typecheck failed');
  const packageRoot = join(PROJECT, request.recipeId.startsWith('API_') ? 'apps/api' : 'apps/web');
  const entry = request.recipeId.endsWith('_TYPECHECK')
    ? join(packageRoot, 'node_modules/typescript/bin/tsc')
    : join(packageRoot, 'node_modules/vitest/vitest.mjs');
  const outcome = checkedRun(
    '/usr/bin/node',
    [entry, ...request.recipe.args],
    packageRoot,
    request.recipeId.endsWith('_TEST') ? 360_000 : 240_000,
  );
  if (outcome.status !== 0) throw new Error('Pinned check returned nonzero');
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'one-file-post-apply-check-executed',
      recipeId: request.recipeId,
      filePathSha256: sha(request.path),
      proposedSha256: request.expectedSha,
      stageFiles: staged.files,
      stageBytes: staged.bytes,
      testsExecuted: request.recipeId.endsWith('_TEST'),
      typecheckExecuted: request.recipeId.endsWith('_TYPECHECK'),
      exitCode: 0,
      sourceReadOnly: true,
      networkEnabled: false,
      lifecycleScriptsExecuted: false,
      arbitraryCommandsEnabled: false,
      stdoutBytes: outcome.stdoutBytes,
      stderrBytes: outcome.stderrBytes,
    }) + '\n',
  );
}

if (process.argv[1] === '/opt/gym-dev-hub/patch-checks-local.mjs') {
  main().catch(() => {
    process.stderr.write(
      'Fixed patch check rejected or failed. Review offline deps and worktree.\n',
    );
    process.exitCode = 1;
  });
}
