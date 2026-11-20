import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXED,
  verifyLocalProof,
  verifyImageMetadata,
  verifyProvisionerIsolation,
} from './provision-pinned-api-local.mjs';

const receipt = () => ({
  protocol: 1,
  event: 'pinned-api-typecheck-local-executed',
  recipe: 'API_TYPECHECK',
  sourceCommit: FIXED.commit,
  sourceTree: FIXED.tree,
  sourceManifestSha256: FIXED.manifest,
  typescriptVersion: '6.0.3',
  prismaGenerated: true,
  apiTypecheckExecuted: true,
  typecheckExitCode: 0,
  sourceReadOnly: true,
  networkEnabled: false,
  dependencyLifecycleScriptsExecuted: false,
  arbitraryCommandsEnabled: false,
  delegatedAuthorization: 'host-service-only',
  operatorGrantConsumedInsideContainer: false,
  hostGrantVerificationInsideContainer: false,
  stdoutBytes: 0,
  stderrBytes: 0,
});

describe('local pinned runner provisioning — strict offline receipt', () => {
  it('accepts only the reviewed fixed compiler proof', () => {
    assert.doesNotThrow(() => verifyLocalProof(receipt()));
  });
  for (const [reason, change] of [
    ['wrong repository commit', { sourceCommit: 'a'.repeat(40) }],
    ['wrong tree', { sourceTree: 'f'.repeat(40) }],
    ['wrong tracked-file manifest', { sourceManifestSha256: 'a'.repeat(64) }],
    ['different recipe', { recipe: 'WEB_BUILD' }],
    ['missing generated Prisma Client', { prismaGenerated: false }],
    ['wrong TypeScript', { typescriptVersion: '6.0.2' }],
    ['a failing compiler', { typecheckExitCode: 1 }],
    ['untrusted source write', { sourceReadOnly: false }],
    ['network access', { networkEnabled: true }],
    ['lifecycle scripts', { dependencyLifecycleScriptsExecuted: true }],
    ['arbitrary commands', { arbitraryCommandsEnabled: true }],
    ['claimed grant inside Docker', { operatorGrantConsumedInsideContainer: true }],
    ['forged host grant verification', { hostGrantVerificationInsideContainer: true }],
    ['unauthorized delegation', { delegatedAuthorization: 'docker-claimed' }],
    ['too much stdout', { stdoutBytes: 65_537 }],
    ['too much stderr', { stderrBytes: 65_537 }],
  ]) {
    it('rejects ' + reason, () => {
      assert.throws(() => verifyLocalProof({ ...receipt(), ...change }), /untrusted/);
    });
  }
  it('rejects an incomplete or malformed proof', () => {
    assert.throws(() => verifyLocalProof(null), /untrusted/);
    assert.throws(() => verifyLocalProof({}), /untrusted/);
  });
});

describe('trusted network staging container boundary', () => {
  const expected = () => ({
    NetworkMode: 'bridge',
    ReadonlyRootfs: true,
    Privileged: false,
    IpcMode: 'none',
    PidsLimit: 256,
    Memory: 5368709120,
    NanoCpus: 2000000000,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=3072m,mode=1777' },
    Mounts: [{ Type: 'bind', Target: '/bundle', ReadOnly: false }],
  });
  it('permits only one disposable output bind; no extra host mounts', () => {
    assert.doesNotThrow(() => verifyProvisionerIsolation(expected()));
    // Docker Desktop omits ReadOnly:false from HostConfig.Mounts when a bind is RW.
    // Actual live mount RW is checked separately before the stage is started.
    assert.doesNotThrow(() =>
      verifyProvisionerIsolation({
        ...expected(),
        Mounts: [{ Type: 'bind', Target: '/bundle' }],
      }),
    );
    for (const candidate of [
      { ...expected(), NetworkMode: 'host' },
      { ...expected(), ReadonlyRootfs: false },
      { ...expected(), Privileged: true },
      {
        ...expected(),
        Mounts: [...expected().Mounts, { Type: 'bind', Target: '/home', ReadOnly: false }],
      },
      { ...expected(), Mounts: [{ Type: 'bind', Target: '/workspace', ReadOnly: false }] },
      { ...expected(), CapDrop: ['NET_ADMIN'] },
      { ...expected(), Tmpfs: { '/tmp': 'rw,nosuid,nodev,exec' } },
    ]) {
      assert.throws(() => verifyProvisionerIsolation(candidate), /unsafe/);
    }
  });
});

describe('local image metadata pinning', () => {
  const id = 'sha256:' + 'a'.repeat(64);
  const runner = () =>
    [
      id,
      '65534:65534',
      'linux',
      'amd64',
      'disabled',
      '["/usr/bin/node","/opt/gym-dev-hub/runner.mjs"]',
    ].join('|');
  const provisioner = () =>
    [
      id,
      '65534:65534',
      'linux',
      'amd64',
      'fixed-pinned-source-only',
      '["/bin/sh","/opt/gym-dev-hub/stage-pinned-api.sh"]',
    ].join('|');

  it('pins the precise trusted provisioner and non-executing runner', () => {
    assert.doesNotThrow(() => verifyImageMetadata(runner(), id, 'runner'));
    assert.doesNotThrow(() => verifyImageMetadata(provisioner(), id, 'provisioner'));
  });
  it('rejects an altered image ID, privilege, platform, entrypoint or label', () => {
    for (const corrupted of [
      runner().replace(id, 'sha256:' + 'b'.repeat(64)),
      runner().replace('65534:65534', '0:0'),
      runner().replace('linux', 'windows'),
      runner().replace('amd64', 'arm64'),
      runner().replace('disabled', 'enabled'),
      runner().replace('runner.mjs', 'untrusted.mjs'),
    ]) {
      assert.throws(() => verifyImageMetadata(corrupted, id, 'runner'), /Unexpected/);
    }
    assert.throws(
      () =>
        verifyImageMetadata(
          provisioner().replace('fixed-pinned-source-only', 'flexible'),
          id,
          'provisioner',
        ),
      /Unexpected/,
    );
  });
});
