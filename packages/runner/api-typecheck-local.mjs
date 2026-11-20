/**
 * Host-authorized local entrypoint. Reuses the exact CI-proven fixed recipe
 * without exposing a generic command surface. Host validates/burns the grant;
 * container deliberately does NOT receive the bearer token or operator secret.
 */
import { spawnSync } from 'node:child_process';

const SOURCE_COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const SOURCE_TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const MANIFEST = 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';

export function verifyFixedCompilerReceipt(reply) {
  if (
    !reply ||
    reply.protocol !== 1 ||
    reply.event !== 'pinned-api-typecheck-ci-only' ||
    reply.recipe !== 'API_TYPECHECK' ||
    reply.sourceCommit !== SOURCE_COMMIT ||
    reply.sourceTree !== SOURCE_TREE ||
    reply.sourceManifestSha256 !== MANIFEST ||
    reply.typescriptVersion !== '6.0.3' ||
    reply.prismaGenerated !== true ||
    reply.apiTypecheckExecuted !== true ||
    reply.typecheckExitCode !== 0 ||
    reply.networkEnabled !== false ||
    reply.sourceReadOnly !== true ||
    reply.privateProjectCopy !== true ||
    reply.dependencyLifecycleScriptsExecuted !== false ||
    reply.operatorGrantConsumed !== false ||
    reply.hubTaskExecutionEnabled !== false ||
    reply.arbitraryCommandsEnabled !== false ||
    !Number.isSafeInteger(reply.stdoutBytes) ||
    !Number.isSafeInteger(reply.stderrBytes) ||
    reply.stdoutBytes < 0 ||
    reply.stderrBytes < 0 ||
    reply.stdoutBytes > 65536 ||
    reply.stderrBytes > 65536
  )
    throw new Error('Fixed compiler prerequisite proof mismatch');
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Unexpected local execution arguments');
  const runner = spawnSync('/usr/bin/node', ['/opt/gym-dev-hub/api-typecheck-ci.mjs'], {
    shell: false,
    cwd: '/opt/gym-dev-hub',
    timeout: 540000,
    encoding: 'utf8',
    maxBuffer: 65536,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/workspace',
      TMPDIR: '/workspace',
      TMP: '/workspace',
      TEMP: '/workspace',
      XDG_CACHE_HOME: '/workspace/.cache',
      XDG_DATA_HOME: '/workspace/.local/share',
      CI: 'true',
    },
  });
  if (runner.error || runner.signal || runner.status !== 0) {
    throw new Error('Fixed compiler returned nonzero or exceeded bounded resources');
  }
  const receipt = JSON.parse(runner.stdout.trim());
  verifyFixedCompilerReceipt(receipt);
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      event: 'pinned-api-typecheck-local-executed',
      recipe: 'API_TYPECHECK',
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
      sourceManifestSha256: MANIFEST,
      typescriptVersion: '6.0.3',
      prismaGenerated: true,
      apiTypecheckExecuted: true,
      typecheckExitCode: 0,
      networkEnabled: false,
      sourceReadOnly: true,
      dependencyLifecycleScriptsExecuted: false,
      arbitraryCommandsEnabled: false,
      delegatedAuthorization: 'host-service-only',
      operatorGrantConsumedInsideContainer: false,
      hostGrantVerificationInsideContainer: false,
      stdoutBytes: receipt.stdoutBytes,
      stderrBytes: receipt.stderrBytes,
    }) + '\n',
  );
}

if (process.argv[1] === '/opt/gym-dev-hub/api-typecheck-local.mjs') {
  main().catch((error) => {
    process.stderr.write(
      'Local fixed typecheck rejected: ' +
        (error instanceof Error ? error.message.slice(0, 600) : 'unknown') +
        '\n',
    );
    process.exitCode = 1;
  });
}
