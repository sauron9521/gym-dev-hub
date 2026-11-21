import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSigkillCli, verifyOwnedContainer } from './launch-sigkill-recovery-smoke.mjs';

const image = 'sha256:' + 'a'.repeat(64);
const key = 'b'.repeat(64);
const root = '/tmp/gym-dev-hub-sigkill-testfixture';
const name = 'gym-dev-hub-patch-check-00000000-0000-4000-8000-000000000456';
const source = root + '/.gym-dev-hub-check-stage-private';
const stage = '/tmp/gym-dev-hub-patch-store-ownedfixture/' + key;

function specimen() {
  return {
    Name: '/' + name,
    Image: image,
    Config: { User: '65534:65534' },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false },
    State: { Running: true },
    Mounts: [
      { Destination: '/source', Source: source, RW: false },
      { Destination: '/store', Source: stage, RW: false },
    ],
  };
}

test('requires an explicit one-off opt-in, non-root Linux and local pinned Docker', () => {
  const env = {
    DEV_HUB_PATCH_CHECK_IMAGE_ID: image,
    DEV_HUB_PATCH_CHECK_PNPM_STORE: '/some/' + key,
  };
  assert.doesNotThrow(() =>
    validateSigkillCli(['--confirm-isolated-sigkill-recovery'], env, 'linux', 1000),
  );
  assert.throws(() => validateSigkillCli([], env, 'linux', 1000));
  assert.throws(() =>
    validateSigkillCli(['--confirm-isolated-sigkill-recovery', '--unsafe'], env, 'linux', 1000),
  );
  assert.throws(() => validateSigkillCli(['--confirm-isolated-sigkill-recovery'], env, 'linux', 0));
  assert.throws(() =>
    validateSigkillCli(['--confirm-isolated-sigkill-recovery'], env, 'win32', 1000),
  );
  assert.throws(() =>
    validateSigkillCli(
      ['--confirm-isolated-sigkill-recovery'],
      { ...env, DOCKER_HOST: 'tcp://server' },
      'linux',
      1000,
    ),
  );
  assert.throws(() =>
    validateSigkillCli(
      ['--confirm-isolated-sigkill-recovery'],
      { ...env, DOCKER_CONTEXT: 'remote' },
      'linux',
      1000,
    ),
  );
  assert.throws(() =>
    validateSigkillCli(
      ['--confirm-isolated-sigkill-recovery'],
      { ...env, DOCKER_TLS_VERIFY: '1' },
      'linux',
      1000,
    ),
  );
  assert.throws(() =>
    validateSigkillCli(
      ['--confirm-isolated-sigkill-recovery'],
      { ...env, DEV_HUB_PATCH_CHECK_IMAGE_ID: 'runner:latest' },
      'linux',
      1000,
    ),
  );
});

test('identifies only a verified, read-only, networkless, nonroot owned Docker container', () => {
  assert.equal(
    verifyOwnedContainer(specimen(), name, root, image, key),
    '/tmp/gym-dev-hub-patch-store-ownedfixture',
  );
  const bad = [
    { Name: '/other-check' },
    { Image: 'sha256:' + 'c'.repeat(64) },
    { Config: { User: '0:0' } },
    { HostConfig: { NetworkMode: 'bridge', ReadonlyRootfs: true, Privileged: false } },
    { HostConfig: { NetworkMode: 'none', ReadonlyRootfs: false, Privileged: false } },
    { HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: true } },
    { State: { Running: false } },
    {
      Mounts: [
        { Destination: '/source', Source: '/home/user/project', RW: false },
        { Destination: '/store', Source: stage, RW: false },
      ],
    },
    {
      Mounts: [
        { Destination: '/source', Source: source, RW: true },
        { Destination: '/store', Source: stage, RW: false },
      ],
    },
    {
      Mounts: [
        { Destination: '/source', Source: source, RW: false },
        {
          Destination: '/store',
          Source: '/tmp/gym-dev-hub-patch-store-foreign/' + 'd'.repeat(64),
          RW: false,
        },
      ],
    },
    {
      Mounts: [
        { Destination: '/source', Source: source, RW: false },
        { Destination: '/store', Source: stage, RW: false },
        { Destination: '/secrets', Source: '/home/operator/.env', RW: false },
      ],
    },
  ];
  for (const change of bad) {
    assert.throws(() => verifyOwnedContainer({ ...specimen(), ...change }, name, root, image, key));
  }
  assert.throws(() => verifyOwnedContainer(specimen(), 'foreign', root, image, key));
  assert.throws(() => verifyOwnedContainer(specimen(), name, '/home/user', image, key));
});

test('cleanup identity may accept stopped verified container, but never changed source/identity', () => {
  const stopped = { ...specimen(), State: { Running: false } };
  assert.throws(() => verifyOwnedContainer(stopped, name, root, image, key));
  assert.equal(
    verifyOwnedContainer(stopped, name, root, image, key, false),
    '/tmp/gym-dev-hub-patch-store-ownedfixture',
  );
  assert.throws(() =>
    verifyOwnedContainer(
      {
        ...stopped,
        Mounts: [
          { Destination: '/source', Source: '/tmp/foreign-stage', RW: false },
          { Destination: '/store', Source: stage, RW: false },
        ],
      },
      name,
      root,
      image,
      key,
      false,
    ),
  );
});
