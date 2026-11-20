import { describe, expect, it } from 'vitest';
import {
  RUNNER_IMAGE,
  diagnosticRunnerArguments,
  validateRunnerImage,
} from '../src/runner/runner-policy.js';

const IMAGE_ID = 'sha256:' + 'a'.repeat(64);
const NAME = 'gym-dev-hub-node-runner-00000000-0000-4000-8000-000000000055';
const CONFIG = {
  Entrypoint: ['/usr/bin/node', '/opt/gym-dev-hub/runner.mjs'],
  User: '65534:65534',
  Labels: {
    'org.gym-dev-hub.runner.protocol': '1',
    'org.gym-dev-hub.runner.execution': 'disabled',
    'org.gym-dev-hub.runner.toolchain': 'node24-pnpm12.18.0',
  },
};

describe('non-executing Node task runner foundation', () => {
  it('requires fixed image identity, non-root entrypoint and exact immutable labels', () => {
    expect(RUNNER_IMAGE).toBe('gym-dev-hub-node-runner:v1');
    expect(validateRunnerImage(IMAGE_ID + '|' + JSON.stringify(CONFIG))).toBe(IMAGE_ID);
    expect(() => validateRunnerImage('latest|' + JSON.stringify(CONFIG))).toThrow();
    expect(() => validateRunnerImage('sha256:bad|' + JSON.stringify(CONFIG))).toThrow();
    expect(() => validateRunnerImage(IMAGE_ID + '|not-json')).toThrow();
    expect(() =>
      validateRunnerImage(IMAGE_ID + '|' + JSON.stringify({ ...CONFIG, User: '0:0' })),
    ).toThrow();
    expect(() =>
      validateRunnerImage(
        IMAGE_ID + '|' + JSON.stringify({ ...CONFIG, Entrypoint: ['/bin/sh', '-c'] }),
      ),
    ).toThrow();
    expect(() =>
      validateRunnerImage(
        IMAGE_ID +
          '|' +
          JSON.stringify({
            ...CONFIG,
            Labels: { ...CONFIG.Labels, 'org.gym-dev-hub.runner.execution': 'enabled' },
          }),
      ),
    ).toThrow();
    expect(() =>
      validateRunnerImage(
        IMAGE_ID +
          '|' +
          JSON.stringify({
            ...CONFIG,
            Labels: { ...CONFIG.Labels, 'org.gym-dev-hub.runner.toolchain': 'node22-pnpm12' },
          }),
      ),
    ).toThrow();
  });

  it('locks every Docker launch flag and does not accept any host mount, network or command', () => {
    const args = diagnosticRunnerArguments(NAME, IMAGE_ID);
    expect(args).toEqual([
      'run',
      '--rm',
      '-i',
      '--pull=never',
      '--name',
      NAME,
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--user=65534:65534',
      '--pids-limit=128',
      '--memory=2048m',
      '--cpus=2',
      '--ipc=none',
      '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777',
      '--stop-timeout=3',
      IMAGE_ID,
    ]);
    expect(args).not.toContain('--privileged');
    expect(args.join(' ')).not.toMatch(/--mount|--volume|docker.sock|--network=bridge|--env|-v /);
  });

  it('rejects user-supplied names, shell-like arguments and mutable image tags', () => {
    for (const name of [
      '',
      'gym-dev-hub-node-runner',
      'gym-dev-hub-node-runner-../../evil',
      'gym-dev-hub-node-runner-00000000-0000-4000-8000-000000000055 --privileged',
    ]) {
      expect(() => diagnosticRunnerArguments(name, IMAGE_ID)).toThrow();
    }
    for (const image of ['node:24-alpine', 'latest', '', 'sha256:' + 'a'.repeat(63)]) {
      expect(() => diagnosticRunnerArguments(NAME, image)).toThrow();
    }
  });
});
