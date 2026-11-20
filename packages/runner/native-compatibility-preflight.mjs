/**
 * CI-only pinned native artifact inspection on a disposable Gym API install.
 * No native .node import, dynamic linking, package lifecycle hook, task grant,
 * API typecheck or Hub execution route is enabled by this proof.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { inspectInstalledNativeArtifacts } from './native-binary-inspect.mjs';

const COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const MANIFEST = 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';
const ENGINE_SHA256 = 'c583d08ce5150fe39ff1d4a981c790e3eee8e1fbb432b80dba7606d74c1e56cf';
const ENGINE = '/engine/schema-engine';
const PROJECT = '/workspace/project';

async function main() {
  if (process.argv.length !== 2) {
    throw new Error('Unexpected native audit arguments');
  }
  const cacheEntrypoint = '/opt/gym-dev-hub/offline-api-cache.mjs';
  const child = spawnSync('/usr/bin/node', [cacheEntrypoint], {
    cwd: '/opt/gym-dev-hub',
    shell: false,
    encoding: 'utf8',
    timeout: 450000,
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
      npm_config_update_notifier: 'false',
    },
  });
  if (child.error || child.signal || child.status !== 0) {
    throw new Error(
      'Pinned offline dependency preflight failed before native inspection',
    );
  }
  const install = JSON.parse(child.stdout.trim());
  if (
    install.event !== 'real-api-dependency-cache-installed-offline' ||
    install.commit !== COMMIT ||
    install.sourceTree !== TREE ||
    install.sourceManifestSha256 !== MANIFEST ||
    install.offlineInstall !== true ||
    install.ignoreScripts !== true ||
    install.immutableOriginalSource !== true ||
    install.executionEnabled !== false ||
    install.prismaGenerated !== false ||
    install.typecheckExecuted !== false
  ) {
    throw new Error('Unreviewed or unverified API artifact closure');
  }
  const engineBytes = await readFile(ENGINE);
  const sha = createHash('sha256').update(engineBytes).digest('hex');
  if (sha !== ENGINE_SHA256) {
    throw new Error('Prisma native engine identity mismatch');
  }

  const inventory = await inspectInstalledNativeArtifacts(PROJECT, ENGINE);
  if (inventory.prismaSchemaEngine.status !== 'elf64-x86_64-header') {
    throw new Error(
      'Pinned Prisma schema-engine is not a usable ELF64 x86_64 header',
    );
  }
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'pinned-native-binary-inventory-static-only',
      sourceCommit: COMMIT,
      sourceTree: TREE,
      schemaEngineSha256: sha,
      dependencyLifecycleScriptsExecuted: false,
      targetCodeExecuted: false,
      nativeModulesLoaded: false,
      apiTypecheckExecuted: false,
      operatorGrantConsumed: false,
      taskExecutionEnabled: false,
      networkEnabled: false,
      sourceReadOnly: true,
      ...inventory,
    }) + '\n',
  );
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message.slice(0, 1200) : 'unknown';
  process.stderr.write('Native prebuilt inventory rejected: ' + message + '\n');
  process.exitCode = 1;
});
