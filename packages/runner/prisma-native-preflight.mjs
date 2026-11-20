/**
 * CI-only reviewed Prisma 7 generator proof for an immutable Gym Platform Git
 * snapshot. Uses the already validated script-free full offline API install,
 * then runs one fixed Prisma CLI on the PRIVATE copy, never the source bind.
 * Not callable via runner protocol, Hub HTTP, task grants or Codex.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE = '/source';
const PROJECT = '/workspace/project';
const API = join(PROJECT, 'apps', 'api');
const GENERATED = join(API, 'src', 'infra', 'database', 'generated', 'prisma');
const COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const MANIFEST_SHA256 = 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';

function run(command, args, cwd, timeout) {
  const result = spawnSync(command, args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout,
    maxBuffer: 24000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/workspace',
      TMPDIR: '/workspace',
      TMP: '/workspace',
      TEMP: '/workspace',
      XDG_CACHE_HOME: '/workspace/.cache',
      XDG_DATA_HOME: '/workspace/.local/share',
      CI: 'true',
      PRISMA_HIDE_UPDATE_MESSAGE: 'true',
      npm_config_update_notifier: 'false',
      // No DATABASE_URL, GitHub token, app secrets or registry credentials.
    },
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error('Bounded Prisma provisioning command interrupted');
  }
  return result;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyGeneratedFiles(path, depth, tally) {
  if (depth > 8) throw new Error('Unexpected Prisma generator output depth');
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('Prisma output contains a symlink');
  if (info.isDirectory()) {
    tally.dirs++;
    if (tally.dirs > 500) throw new Error('Prisma output directory count exceeded');
    for (const name of await readdir(path)) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        throw new Error('Unsafe generated path');
      }
      await verifyGeneratedFiles(join(path, name), depth + 1, tally);
    }
  } else if (info.isFile()) {
    tally.files++;
    tally.bytes += info.size;
    if (tally.files > 5000 || tally.bytes > 48 * 1024 * 1024) {
      throw new Error('Prisma generated output quota exceeded');
    }
  } else {
    throw new Error('Prisma generated unexpected special file');
  }
}

async function mustNotExist(path) {
  try {
    await lstat(path);
    throw new Error('Prisma output unexpectedly exists in immutable source');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No caller arguments permitted');
  // Script-free offline full API dependency install also validates the full
  // pinned source, manifest, store safety and three private tmpfs mounts.
  const installed = run(
    '/usr/bin/node',
    ['/opt/gym-dev-hub/offline-api-cache.mjs'],
    '/opt/gym-dev-hub',
    450000,
  );
  if (installed.status !== 0) {
    throw new Error(
      'Offline API dependency prerequisite failed: ' +
        (installed.stderr || installed.stdout || 'unknown').slice(0, 1000),
    );
  }
  const preflight = JSON.parse(installed.stdout.trim());
  if (
    preflight.event !== 'real-api-dependency-cache-installed-offline' ||
    preflight.commit !== COMMIT ||
    preflight.sourceTree !== TREE ||
    preflight.sourceManifestSha256 !== MANIFEST_SHA256 ||
    preflight.offlineInstall !== true ||
    preflight.ignoreScripts !== true ||
    preflight.prismaGenerated !== false ||
    preflight.executionEnabled !== false
  ) {
    throw new Error('Unreviewed source or incomplete offline dependency prerequisite');
  }
  const sourceLock = digest(await readFile(join(SOURCE, 'pnpm-lock.yaml')));
  if (preflight.lockSha256 !== sourceLock) {
    throw new Error('Git-pinned lockfile digest changed');
  }
  const config = await readFile(join(API, 'prisma7.config.ts'), 'utf8');
  const schema = await readFile(join(API, 'prisma', 'schemas', 'schema.prisma'), 'utf8');
  if (
    !config.includes("schema: 'prisma/schemas/'") ||
    !config.includes("url: process.env['DATABASE_URL']") ||
    !schema.includes('provider        = "prisma-client"') ||
    !schema.includes('output          = "../../src/infra/database/generated/prisma"')
  ) {
    throw new Error('Unreviewed Prisma generation configuration');
  }
  await mustNotExist(join(SOURCE, 'apps', 'api', 'src', 'infra', 'database', 'generated', 'prisma'));
  await mustNotExist(GENERATED);

  const cli = run(
    '/bin/sh',
    [
      '/usr/bin/devhub-pnpm',
      '--dir',
      API,
      'exec',
      'prisma',
      'generate',
      '--config',
      'prisma7.config.ts',
      '--no-hints',
    ],
    API,
    150000,
  );
  if (cli.status !== 0) {
    throw new Error(
      'Fixed Prisma 7 offline generate failed: ' +
        (cli.stderr || cli.stdout || 'unknown').slice(0, 1250),
    );
  }
  const output = { dirs: 0, files: 0, bytes: 0 };
  await verifyGeneratedFiles(GENERATED, 0, output);
  if (output.files < 6 || output.bytes < 2000) {
    throw new Error('Prisma generator emitted no meaningful client');
  }
  for (const required of ['client.ts', 'browser.ts', 'enums.ts']) {
    const stat = await lstat(join(GENERATED, required));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Missing expected Prisma 7 generated file: ' + required);
    }
  }
  await mustNotExist(join(SOURCE, 'apps', 'api', 'src', 'infra', 'database', 'generated', 'prisma'));
  if (digest(await readFile(join(PROJECT, 'pnpm-lock.yaml'))) !== sourceLock) {
    throw new Error('Pinned project lock changed during Prisma generation');
  }

  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'pinned-prisma-client-generated-in-private-overlay',
      sourceCommit: COMMIT,
      sourceTree: TREE,
      sourceManifestSha256: MANIFEST_SHA256,
      prismaVersion: '7.10.1',
      outputPath: 'apps/api/src/infra/database/generated/prisma',
      generatedFiles: output.files,
      generatedBytes: output.bytes,
      networkEnabled: false,
      sourceReadOnly: true,
      privateProjectCopy: true,
      fullOfflineDependenciesInstalled: true,
      dependencyLifecycleScriptsExecuted: false,
      prismaClientGeneratorExecuted: true,
      nativeLifecycleScriptsExecuted: false,
      apiTypecheckExecuted: false,
      operatorGrantConsumed: false,
      taskExecutionEnabled: false,
    }) + '\n',
  );
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message.slice(0, 1500) : 'unknown';
  process.stderr.write('Prisma private generation proof rejected: ' + detail + '\n');
  process.exitCode = 1;
});
