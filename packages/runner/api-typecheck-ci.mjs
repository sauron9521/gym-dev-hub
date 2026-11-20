/**
 * CI-only fixed API_TYPECHECK proof against one immutable Gym Platform snapshot.
 * This file is NOT called by the Hub API, operator grants, or runner.mjs.
 * The Prisma prerequisite verifies and prepares a disposable offline worktree.
 * Only the reviewed TypeScript CLI may run; no package scripts or client argv.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PINNED_API = Object.freeze({
  commit: '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a',
  tree: '2c140e1e740b3dd8cc7582db726f46b54b73b334',
  manifest: 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b',
  engineSha: 'c583d08ce5150fe39ff1d4a981c790e3eee8e1fbb432b80dba7606d74c1e56cf',
  typescript: '6.0.3',
});

const SOURCE = '/source';
const PROJECT = '/workspace/project';
const API = join(PROJECT, 'apps', 'api');
const MAX_OUTPUT = 65536;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(executable, args, cwd, timeout) {
  const result = spawnSync(executable, args, {
    cwd,
    shell: false,
    timeout,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/workspace',
      TMPDIR: '/workspace',
      TMP: '/workspace',
      TEMP: '/workspace',
      XDG_CACHE_HOME: '/workspace/.cache',
      XDG_DATA_HOME: '/workspace/.local/share',
      PRISMA_HIDE_UPDATE_MESSAGE: 'true',
      npm_config_update_notifier: 'false',
      CI: 'true',
      // No DATABASE_URL, task token, operator secret or GitHub credentials.
    },
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error('Bounded API TypeScript process interrupted or exceeded output quota');
  }
  return result;
}

/** Independently check every security claim from the preceding private generator. */
export function verifyPrismaReceipt(result) {
  if (
    !result ||
    result.protocol !== 1 ||
    result.event !== 'pinned-prisma-client-generated-in-private-overlay' ||
    result.sourceCommit !== PINNED_API.commit ||
    result.sourceTree !== PINNED_API.tree ||
    result.sourceManifestSha256 !== PINNED_API.manifest ||
    result.prismaVersion !== '7.10.1' ||
    result.schemaEngineSha256 !== PINNED_API.engineSha ||
    result.schemaEnginePlatform !== 'linux-musl-openssl-3.0.x' ||
    result.outputPath !== 'apps/api/src/infra/database/generated/prisma' ||
    !Number.isSafeInteger(result.generatedFiles) ||
    result.generatedFiles < 6 ||
    !Number.isSafeInteger(result.generatedBytes) ||
    result.generatedBytes < 2000 ||
    result.networkEnabled !== false ||
    result.sourceReadOnly !== true ||
    result.privateProjectCopy !== true ||
    result.fullOfflineDependenciesInstalled !== true ||
    result.dependencyLifecycleScriptsExecuted !== false ||
    result.nativeLifecycleScriptsExecuted !== false ||
    result.prismaClientGeneratorExecuted !== true ||
    result.apiTypecheckExecuted !== false ||
    result.operatorGrantConsumed !== false ||
    result.taskExecutionEnabled !== false
  ) {
    throw new Error('Prisma generation or immutable offline source proof is unverified');
  }
}

/** Client-supplied command strings never become executable instructions. */
export function verifyTypecheckRecipe(pkg, config) {
  if (
    !pkg ||
    pkg.name !== '@gym/api' ||
    pkg.scripts?.typecheck !== 'tsc --noEmit -p tsconfig.build.json' ||
    !config ||
    config.extends !== './tsconfig.json' ||
    config.compilerOptions?.rootDir !== './src' ||
    JSON.stringify(config.include) !== JSON.stringify(['src'])
  ) {
    throw new Error('Pinned Gym API compiler recipe is not the reviewed fixed command');
  }
}

async function pinnedCompiler() {
  for (const candidate of [
    join(PROJECT, 'node_modules', 'typescript'),
    join(API, 'node_modules', 'typescript'),
  ]) {
    try {
      const pkg = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
      if (pkg.name !== 'typescript' || pkg.version !== PINNED_API.typescript) {
        throw new Error('Unreviewed TypeScript executable version');
      }
      const path = join(candidate, 'bin', 'tsc');
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 100) {
        throw new Error('TypeScript entrypoint is not a safe regular file');
      }
      return path;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Pinned TypeScript compiler missing from offline dependency closure');
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No API typecheck arguments accepted');
  const generated = run(
    '/usr/bin/node',
    ['/opt/gym-dev-hub/prisma-native-preflight.mjs'],
    '/opt/gym-dev-hub',
    400000,
  );
  if (generated.status !== 0) {
    throw new Error(
      'Pinned Prisma prerequisite failed: ' +
        (generated.stderr || generated.stdout || '').slice(0, 1000),
    );
  }
  verifyPrismaReceipt(JSON.parse(generated.stdout.trim()));
  const sourceLock = digest(await readFile(join(SOURCE, 'pnpm-lock.yaml')));
  const privateLock = digest(await readFile(join(PROJECT, 'pnpm-lock.yaml')));
  if (sourceLock !== privateLock) throw new Error('Pinned lockfile changed before typecheck');

  verifyTypecheckRecipe(
    JSON.parse(await readFile(join(SOURCE, 'apps/api/package.json'), 'utf8')),
    JSON.parse(await readFile(join(SOURCE, 'apps/api/tsconfig.build.json'), 'utf8')),
  );
  const cli = await pinnedCompiler();
  const executed = run(
    '/usr/bin/node',
    [cli, '--noEmit', '-p', 'tsconfig.build.json'],
    API,
    240000,
  );
  if (executed.status !== 0) {
    // Print only a bounded diagnostic preview; avoid unbounded user-generated logs.
    throw new Error(
      'Fixed API TypeScript check returned ' +
        executed.status +
        ': ' +
        (executed.stderr || executed.stdout || '').slice(0, 1600),
    );
  }
  if (
    digest(await readFile(join(SOURCE, 'pnpm-lock.yaml'))) !== sourceLock ||
    digest(await readFile(join(PROJECT, 'pnpm-lock.yaml'))) !== sourceLock
  ) {
    throw new Error('Pinned lockfile changed during API typecheck');
  }

  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'pinned-api-typecheck-ci-only',
      recipe: 'API_TYPECHECK',
      sourceCommit: PINNED_API.commit,
      sourceTree: PINNED_API.tree,
      sourceManifestSha256: PINNED_API.manifest,
      typescriptVersion: PINNED_API.typescript,
      prismaGenerated: true,
      apiTypecheckExecuted: true,
      typecheckExitCode: 0,
      networkEnabled: false,
      sourceReadOnly: true,
      privateProjectCopy: true,
      dependencyLifecycleScriptsExecuted: false,
      operatorGrantConsumed: false,
      hubTaskExecutionEnabled: false,
      arbitraryCommandsEnabled: false,
      stdoutBytes: Buffer.byteLength(executed.stdout),
      stderrBytes: Buffer.byteLength(executed.stderr),
    }) + '\n',
  );
}

if (process.argv[1] === '/opt/gym-dev-hub/api-typecheck-ci.mjs') {
  main().catch((error) => {
    process.stderr.write(
      'Private API TypeScript proof rejected: ' +
        (error instanceof Error ? error.message.slice(0, 2000) : 'unknown') +
        '\n',
    );
    process.exitCode = 1;
  });
}
