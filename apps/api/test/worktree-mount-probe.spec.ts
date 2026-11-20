import { describe, expect, it } from 'vitest';
import { mountedWorkerArguments, validateObservedMounts } from '../src/worktree/worktree-mount-probe.js';

const ID = 'sha256:' + 'a'.repeat(64);
const NAME = 'gym-dev-hub-worker-00000000-0000-4000-8000-000000000111';
const SOURCE = process.platform === 'win32' ? 'C:\\worktrees\\approved' : '/tmp/worktrees/approved';

describe('immutable mounted worker CLI policy', () => {
  it('inherits all safety flags and inserts a single read-only mount before immutable image ID', () => {
    const args = mountedWorkerArguments(NAME, ID, SOURCE);
    const mount = args[args.indexOf('--mount') + 1];
    expect(mount).toBe(`type=bind,source=${SOURCE},target=/workspace,readonly`);
    expect(args[args.length - 1]).toBe(ID);
    expect(args).toEqual(expect.arrayContaining([
      '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--ipc=none',
      '--user=65534:65534', '--pull=never',
    ]));
    expect(args.filter((item) => item === '--mount')).toHaveLength(1);
    expect(args).not.toContain('--privileged');
    expect(args.join(' ')).not.toContain('docker.sock');
  });

  it.each(['../danger', '/tmp/unsafe,other=true', '/tmp/unsafe\nmore', '/var/run/docker.sock'])(
    'rejects a noncanonical or unsafe path: %s', (path) => {
      expect(() => mountedWorkerArguments(NAME, ID, path)).toThrow();
    },
  );

  it('requires Docker to report only the exact approved read-only host mount', () => {
    const data = [{ Type: 'bind', Source: SOURCE, Target: '/workspace', ReadOnly: true }];
    expect(() => validateObservedMounts(JSON.stringify(data), SOURCE)).not.toThrow();
    expect(() => validateObservedMounts(JSON.stringify([
      ...data, { Type: 'bind', Source: '/var/run/docker.sock', Target: '/sock', ReadOnly: false },
    ]), SOURCE)).toThrow();
    expect(() => validateObservedMounts(JSON.stringify([{ ...data[0], ReadOnly: false }]), SOURCE)).toThrow();
    expect(() => validateObservedMounts(JSON.stringify([{ ...data[0], Source: '/private' }]), SOURCE)).toThrow();
    expect(() => validateObservedMounts(JSON.stringify([{ ...data[0], Target: '/root' }]), SOURCE)).toThrow();
    expect(() => validateObservedMounts('not-json', SOURCE)).toThrow();
  });
});
