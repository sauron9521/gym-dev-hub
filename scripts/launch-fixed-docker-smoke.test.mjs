import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSmokeCli } from './launch-fixed-docker-smoke.mjs';

const env = {
  DEV_HUB_PATCH_CHECK_IMAGE_ID: 'sha256:' + 'a'.repeat(64),
  DEV_HUB_PATCH_CHECK_PNPM_STORE: '/trusted/private/pnpm-store',
};
test('explicit non-root Linux confirmation and pinned prerequisites required', () => {
  assert.doesNotThrow(() =>
    validateSmokeCli(['--confirm-isolated-docker-smoke'], env, 'linux', 1000),
  );
  for (const args of [[], ['--help'], ['--confirm-isolated-docker-smoke', '--force']])
    assert.throws(() => validateSmokeCli(args, env, 'linux', 1000), /Requires/);
  assert.throws(
    () => validateSmokeCli(['--confirm-isolated-docker-smoke'], env, 'linux', 0),
    /non-root/,
  );
  assert.throws(
    () => validateSmokeCli(['--confirm-isolated-docker-smoke'], env, 'win32', undefined),
    /non-root/,
  );
  assert.throws(
    () =>
      validateSmokeCli(
        ['--confirm-isolated-docker-smoke'],
        { ...env, DEV_HUB_PATCH_CHECK_PNPM_STORE: '' },
        'linux',
        1000,
      ),
    /Missing pinned/,
  );
});

test('remote Docker and credential-bearing overrides denied before any container runs', () => {
  for (const extra of [
    { DOCKER_HOST: 'tcp://localhost:2375' },
    { DOCKER_HOST: 'ssh://somehost' },
    { DOCKER_HOST: 'unix:///tmp/other.sock' },
    { DOCKER_CONTEXT: 'remote' },
    { DOCKER_TLS_VERIFY: '1' },
    { DOCKER_CERT_PATH: '/secrets' },
  ])
    assert.throws(
      () =>
        validateSmokeCli(['--confirm-isolated-docker-smoke'], { ...env, ...extra }, 'linux', 1000),
      /Remote Docker/,
    );
});

test('bare CLI rejects execution without confirmation, including with arbitrary environment', () => {
  const script = fileURLToPath(new URL('./launch-fixed-docker-smoke.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ISOLATED_DOCKER_SMOKE_FAILED/);
  assert.ok(!result.stdout.includes('isolated-real-docker-fixture-verified'));
});
