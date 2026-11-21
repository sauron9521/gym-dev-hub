import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  operatorPorts,
  operatorCommands,
  validateDockerEnvironment,
  validateDockerSocket,
  POLICY,
} from './dev-operator.mjs';

test('operator ports default to local Hub and reject unsafe/malformed values', () => {
  assert.deepEqual(operatorPorts({}), { apiPort: 3101, webPort: 3100 });
  assert.deepEqual(
    operatorPorts({ DEV_HUB_OPERATOR_API_PORT: '3211', DEV_HUB_OPERATOR_WEB_PORT: '3210' }),
    { apiPort: 3211, webPort: 3210 },
  );
  for (const bad of ['0', '80', '65536', '-3101', '3101foo', ' 3101', '01']) {
    assert.throws(() => operatorPorts({ DEV_HUB_OPERATOR_API_PORT: bad }), /port/);
  }
  assert.throws(() => operatorPorts({ DEV_HUB_OPERATOR_WEB_PORT: '3101' }), /share a port/);
});

test('stable API never runs Nest watch while web retains HMR and exact localhost proxy', () => {
  const root = '/work/gym-dev-hub';
  const config = operatorCommands(
    root,
    { apiPort: 3211, webPort: 3210 },
    { EXISTING: 'preserved', DEV_HUB_API_URL: 'http://localhost:9999' },
  );
  assert.deepEqual(config.builds, [
    ['--filter', '@gym-dev-hub/contracts', 'build'],
    ['--filter', '@gym-dev-hub/api', 'build'],
  ]);
  assert.equal(config.api.executable, process.execPath);
  assert.deepEqual(config.api.args, [join(root, 'apps/api/dist/main.js')]);
  assert.equal(config.api.cwd, join(root, 'apps/api'));
  assert.equal(config.api.env.PORT, '3211');
  assert.equal(config.api.env.EXISTING, 'preserved');
  assert.ok(!config.api.args.join(' ').includes('--watch'));
  assert.equal(config.web.executable, process.execPath);
  assert.equal(config.web.cwd, join(root, 'apps/web'));
  assert.deepEqual(config.web.args, [
    join(root, 'apps/web/node_modules/next/dist/bin/next'),
    'dev',
    '--hostname',
    '127.0.0.1',
    '--port',
    '3210',
  ]);
  assert.equal(config.web.env.DEV_HUB_API_URL, 'http://127.0.0.1:3211');
  assert.equal(POLICY.pnpm, '12.18.0');
});

test('operator refuses remote Docker host, context and TLS overrides before contacting Docker', () => {
  assert.doesNotThrow(() => validateDockerEnvironment({}));
  assert.doesNotThrow(() =>
    validateDockerEnvironment({
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      DOCKER_CONTEXT: 'default',
    }),
  );
  for (const env of [
    { DOCKER_HOST: 'tcp://127.0.0.1:2375' },
    { DOCKER_HOST: 'ssh://remote.example' },
    { DOCKER_HOST: 'unix:///tmp/untrusted.sock' },
    { DOCKER_CONTEXT: 'desktop-linux' },
    { DOCKER_TLS_VERIFY: '1' },
    { DOCKER_CERT_PATH: '/tmp/certs' },
  ]) {
    assert.throws(() => validateDockerEnvironment(env), /remote Docker overrides denied/);
  }
});

test('operator Docker endpoint is local Unix socket without world access', () => {
  const socket = (mode, isSocket = true) => ({ mode, isSocket: () => isSocket });
  assert.doesNotThrow(() => validateDockerSocket('unix:///var/run/docker.sock', socket(0o660)));
  for (const endpoint of [
    'tcp://localhost:2375',
    'ssh://remote.example',
    'unix:///tmp/other.sock',
  ]) {
    assert.throws(() => validateDockerSocket(endpoint, socket(0o660)), /trusted private/);
  }
  for (const bad of [socket(0o666), socket(0o661), socket(0o660, false), null]) {
    assert.throws(
      () => validateDockerSocket('unix:///var/run/docker.sock', bad),
      /trusted private/,
    );
  }
});

test('Linux CLI rejects remote Docker before starting API/Web or exposing an override', () => {
  if (process.platform !== 'linux') return;
  const script = fileURLToPath(new URL('./dev-operator.mjs', import.meta.url));
  const remote = 'tcp://example.invalid:2375';
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, DOCKER_HOST: remote },
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remote Docker overrides denied/);
  assert.ok(!result.stderr.includes(remote));
  assert.ok(!result.stdout.includes('OPERATOR_SERVICES_STARTED'));
});
