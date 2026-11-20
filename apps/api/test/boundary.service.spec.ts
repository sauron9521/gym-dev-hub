import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BoundaryService, PROBE_IMAGE, probeArguments } from '../src/boundary/boundary.service.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

type FakeOptions = {
  endpoint?: string;
  os?: string;
  probe?: string;
  error?: boolean;
};

function fakeDocker(options: FakeOptions = {}) {
  const calls: string[][] = [];
  vi.mocked(spawn).mockImplementation((_file, args) => {
    const command = [...(args as string[])];
    calls.push(command);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      if (options.error) {
        child.emit('error', new Error('HOST SECRET'));
        return;
      }
      if (command[0] === 'context') {
        child.stdout.write(
          options.endpoint ??
            (process.platform === 'win32'
              ? 'npipe:////./pipe/dockerDesktopLinuxEngine'
              : 'unix:///var/run/docker.sock'),
        );
      } else if (command[0] === 'info') {
        child.stdout.write(options.os ?? 'linux');
      } else if (command[0] === 'run') {
        child.stdout.write(options.probe ?? 'BOUNDARY_OK');
      }
      child.emit('exit', 0);
    });
    return child as never;
  });
  return calls;
}

describe('Docker boundary preflight', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a fixed deny-by-default Linux container policy with no host mounts', () => {
    const args = probeArguments('gym-dev-hub-probe-00000000-0000-4000-8000-000000000055');
    expect(args).toEqual(
      expect.arrayContaining([
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=65534:65534',
        '--memory=128m',
        '--cpus=0.5',
        '--pids-limit=32',
        '--pull=never',
        PROBE_IMAGE,
      ]),
    );
    expect(args).not.toContain('--privileged');
    expect(
      args.some((arg) => arg.startsWith('--volume') || arg.startsWith('--mount') || arg === '-v'),
    ).toBe(false);
    expect(args.some((arg) => arg.toLowerCase().includes('docker.sock'))).toBe(false);
    expect(args.at(-2)).toBe('-c');
    expect(args.at(-1)).toContain('BOUNDARY_OK');
    expect(() => probeArguments('invalid;rm -rf /')).toThrow('Invalid probe identifier');
  });

  it('checks local Docker, Linux daemon and fixed smoke container', async () => {
    const calls = fakeDocker();
    const boundary = new BoundaryService();
    expect(boundary.status()).toMatchObject({ state: 'not-checked', agentExecutionEnabled: false });
    const result = await boundary.runPreflight();
    expect(calls.map((call) => call[0])).toEqual(['context', 'info', 'run']);
    expect(result).toMatchObject({
      state: 'passed',
      agentExecutionEnabled: false,
      mode: 'docker-linux-preflight',
    });
    expect(result.checkedAt).toBeTruthy();
    expect(result.policy.hostMounts).toBe('none');
    expect(result.policy.rootFilesystem).toBe('read-only');
  });

  it('refuses a remote Docker context without running a container', async () => {
    const calls = fakeDocker({ endpoint: 'tcp://remote.example:2376' });
    const status = await new BoundaryService().runPreflight();
    expect(status).toMatchObject({ state: 'unavailable', agentExecutionEnabled: false });
    expect(calls).toHaveLength(1);
  });

  it('refuses Windows containers', async () => {
    const calls = fakeDocker({ os: 'windows' });
    const status = await new BoundaryService().runPreflight();
    expect(status.state).toBe('unavailable');
    expect(calls.map((call) => call[0])).toEqual(['context', 'info']);
  });

  it('does not claim a passed preflight when container proof fails', async () => {
    fakeDocker({ probe: 'NOT_VERIFIED' });
    const status = await new BoundaryService().runPreflight();
    expect(status).toMatchObject({ state: 'failed', agentExecutionEnabled: false });
  });

  it('hides Docker errors from browser output', async () => {
    fakeDocker({ error: true });
    const status = await new BoundaryService().runPreflight();
    expect(status.state).toBe('unavailable');
    expect(JSON.stringify(status)).not.toContain('HOST SECRET');
  });

  it('never inherits Dev Hub credentials into Docker CLI', async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'sensitive-secret';
    try {
      fakeDocker();
      await new BoundaryService().runPreflight();
      const call = vi.mocked(spawn).mock.calls[0];
      expect(call[2]?.env?.GITHUB_TOKEN).toBeUndefined();
      expect(call[2]?.env?.DATABASE_URL).toBeUndefined();
      expect(call[2]?.shell).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it('coalesces concurrent checks instead of starting multiple Docker instances', async () => {
    const calls = fakeDocker();
    const boundary = new BoundaryService();
    const a = boundary.runPreflight();
    const b = boundary.runPreflight();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(calls).toHaveLength(3);
    expect(boundary.status().state).toBe('passed');
  });
});
