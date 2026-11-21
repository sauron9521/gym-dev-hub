import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { operatorPorts, operatorCommands, POLICY } from './dev-operator.mjs';

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
