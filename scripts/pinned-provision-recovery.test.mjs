import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyProvisionContainer,
} from './pinned-provision-recovery.mjs';
import {
  PROVISIONING_LABEL,
  PROVISIONING_SCOPE,
  PROVISIONING_PHASE_LABEL,
  PROVISIONING_CHECKOUT_LABEL,
  PROVISIONING_CHECKOUT,
} from './provision-pinned-api-local.mjs';

const NOW = Date.parse('2026-11-20T19:00:00Z');
const OLD = '2026-11-18T19:00:00.123456789Z';
const RECENT = '2026-11-20T18:58:00Z';
const ID = 'a'.repeat(64);
const UUID = '11223344-5566-4777-8999-aabbccddeeff';

const labels = (phase) => ({
  [PROVISIONING_LABEL]: PROVISIONING_SCOPE,
  [PROVISIONING_PHASE_LABEL]: phase,
  [PROVISIONING_CHECKOUT_LABEL]: PROVISIONING_CHECKOUT,
  'org.gym-dev-hub.provisioner.mode': 'fixed-pinned-source-only',
  'org.gym-dev-hub.runner.execution': 'disabled',
});

const base = (phase) => ({
  Id: ID,
  Name: phase === 'stage'
    ? '/gym-devhub-pinned-stage-' + UUID
    : '/gym-devhub-provision-check-' + UUID,
  Created: OLD,
  Config: {
    Labels: labels(phase),
    User: '65534:65534',
    Entrypoint: phase === 'stage'
      ? ['/bin/sh', '/opt/gym-dev-hub/stage-pinned-api.sh']
      : ['/usr/bin/node'],
    Cmd: phase === 'stage' ? null : ['/opt/gym-dev-hub/api-typecheck-local.mjs'],
  },
  State: { Status: 'exited', Running: false, Paused: false, Restarting: false },
  HostConfig: {
    NetworkMode: phase === 'stage' ? 'bridge' : 'none',
    ReadonlyRootfs: true,
    Privileged: false,
    IpcMode: 'none',
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    RestartPolicy: { Name: 'no' },
    PidsLimit: phase === 'stage' ? 256 : 128,
    Memory: 5368709120,
    NanoCpus: 2000000000,
  },
  Mounts: phase === 'stage'
    ? [{ Type: 'bind', Destination: '/bundle', RW: true }]
    : ['/source', '/manifest', '/store', '/engine']
      .map((destination) => ({ Type: 'bind', Destination: destination, RW: false })),
});

const clone = (value) => structuredClone(value);
const denied = (item, reason) => {
  const result = classifyProvisionContainer(item, NOW);
  assert.equal(result.removable, false, JSON.stringify(result));
  if (reason) assert.equal(result.reason, reason);
};

describe('explicit recovery of reviewed local pinned containers', () => {
  it('recognizes stopped, older-than-24h stage and offline-smoke containers only', () => {
    for (const phase of ['stage', 'offline-smoke']) {
      const candidate = classifyProvisionContainer(base(phase), NOW);
      assert.deepEqual(candidate, { removable: true, reason: 'stopped-and-stale', phase });
    }
  });

  it('never cleans an actively executing task or a recently created container', () => {
    for (const phase of ['stage', 'offline-smoke']) {
      for (const status of ['running', 'paused', 'restarting', 'dead', 'removing']) {
        const item = base(phase);
        item.State.Status = status;
        if (status === 'running') item.State.Running = true;
        denied(item, 'running-or-unexpected-state');
      }
      const recent = base(phase);
      recent.Created = RECENT;
      denied(recent, 'recent-or-invalid-created-at');
      const future = base(phase);
      future.Created = '2026-11-21T00:00:00Z';
      denied(future, 'recent-or-invalid-created-at');
    }
  });

  it('rejects another checkout, unaudited phase, and lookalike names', () => {
    for (const phase of ['stage', 'offline-smoke']) {
      const foreign = base(phase);
      foreign.Config.Labels[PROVISIONING_CHECKOUT_LABEL] = 'b'.repeat(64);
      denied(foreign, 'foreign-checkout-or-scope');

      const unrelated = base(phase);
      unrelated.Config.Labels[PROVISIONING_LABEL] = 'other-app';
      denied(unrelated, 'foreign-checkout-or-scope');

      const mistyped = base(phase);
      mistyped.Name = mistyped.Name.replace('gym-devhub-', 'gym-platform-');
      denied(mistyped, 'unknown-phase-or-name');

      const missingUuid = base(phase);
      missingUuid.Name = '/gym-devhub-pinned-stage-test';
      denied(missingUuid, 'unknown-phase-or-name');

      const unsupported = base(phase);
      unsupported.Config.Labels[PROVISIONING_PHASE_LABEL] = 'production';
      denied(unsupported, 'unknown-phase-or-name');
    }
  });

  it('refuses unreviewed image entrypoint or other users', () => {
    for (const phase of ['stage', 'offline-smoke']) {
      const wrongUser = base(phase);
      wrongUser.Config.User = '0:0';
      denied(wrongUser, 'unexpected-isolation');
      const extraCaps = base(phase);
      extraCaps.HostConfig.CapDrop = ['NET_ADMIN'];
      denied(extraCaps, 'unexpected-isolation');
      const writableRoot = base(phase);
      writableRoot.HostConfig.ReadonlyRootfs = false;
      denied(writableRoot, 'unexpected-isolation');
      const restart = base(phase);
      restart.HostConfig.RestartPolicy.Name = 'always';
      denied(restart, 'unexpected-isolation');
      const changed = base(phase);
      changed.Config.Entrypoint = ['/bin/sh', '-c'];
      denied(changed, phase === 'stage'
        ? 'unexpected-stage-identity' : 'unexpected-offline-identity');
    }
  });

  it('never removes a staged container with unexpected host mounts or wider network', () => {
    const stage = base('stage');
    const writableOutside = clone(stage);
    writableOutside.Mounts.push({ Type: 'bind', Destination: '/etc', RW: true });
    denied(writableOutside, 'unexpected-stage-identity');

    const wrongFolder = clone(stage);
    wrongFolder.Mounts[0].Destination = '/workspace';
    denied(wrongFolder, 'unexpected-stage-identity');

    const readOnly = clone(stage);
    readOnly.Mounts[0].RW = false;
    denied(readOnly, 'unexpected-stage-identity');

    const hostNet = clone(stage);
    hostNet.HostConfig.NetworkMode = 'host';
    denied(hostNet, 'unexpected-stage-identity');

    const wrongMode = clone(stage);
    wrongMode.Config.Labels['org.gym-dev-hub.provisioner.mode'] = 'custom';
    denied(wrongMode, 'unexpected-stage-identity');
  });

  it('never removes offline smoke containers with writable/missing/extra mounts', () => {
    const smoke = base('offline-smoke');
    const writable = clone(smoke);
    writable.Mounts[1].RW = true;
    denied(writable, 'unexpected-offline-identity');

    const missing = clone(smoke);
    missing.Mounts.pop();
    denied(missing, 'unexpected-offline-identity');

    const extra = clone(smoke);
    extra.Mounts.push({ Type: 'bind', Destination: '/var/run/docker.sock', RW: true });
    denied(extra, 'unexpected-offline-identity');

    const bridge = clone(smoke);
    bridge.HostConfig.NetworkMode = 'bridge';
    denied(bridge, 'unexpected-offline-identity');

    const unexpectedCommand = clone(smoke);
    unexpectedCommand.Config.Cmd = ['/bin/sh'];
    denied(unexpectedCommand, 'unexpected-offline-identity');
  });

  it('rejects a malformed or missing Docker identity', () => {
    denied(null, 'malformed');
    denied({}, 'foreign-checkout-or-scope');
    for (const phase of ['stage', 'offline-smoke']) {
      const noId = base(phase);
      noId.Id = 'short';
      denied(noId, 'invalid-container-identity');
      const badDate = base(phase);
      badDate.Created = 'garbled';
      denied(badDate, 'recent-or-invalid-created-at');
      const unknownState = base(phase);
      unknownState.State.Status = 'unknown';
      denied(unknownState, 'running-or-unexpected-state');
    }
  });
});
