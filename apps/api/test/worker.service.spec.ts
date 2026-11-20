import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { BoundaryService, callDocker } from '../src/boundary/boundary.service.js';
import {
  WorkerService,
  WORKER_IMAGE,
  workerArguments,
  validateWorkerImage,
} from '../src/worker/worker.service.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../src/boundary/boundary.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/boundary/boundary.service.js')>();
  return { ...real, callDocker: vi.fn() };
});

const ID = 'sha256:' + 'a'.repeat(64);
const CONFIG = {
  Entrypoint: ['/bin/sh', '/opt/gym-dev-hub/worker.sh'],
  Labels: {
    'org.gym-dev-hub.worker.protocol': '1',
    'org.gym-dev-hub.worker.execution': 'disabled',
  },
  User: '65534:65534',
};

function mockDocker(options: { remote?: boolean; badImage?: boolean; wrongReply?: boolean } = {}) {
  const calls: string[][] = [];
  const docker = vi.mocked(callDocker);
  docker.mockImplementation(async (args) => {
    calls.push(args);
    if (args[0] === 'context')
      return options.remote
        ? 'tcp://remote.example:2376'
        : process.platform === 'win32'
          ? 'npipe:////./pipe/dockerDesktopLinuxEngine'
          : 'unix:///var/run/docker.sock';
    if (args[0] === 'info') return 'linux';
    if (args[0] === 'image')
      return ID + '|' + JSON.stringify(options.badImage ? { ...CONFIG, User: '0:0' } : CONFIG);
    throw new Error('Unknown Docker command');
  });

  const protocol: string[] = [];
  vi.mocked(spawn).mockImplementation((_exe, _args) => {
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let exitCode: number | null = null;
    stdin.on('data', (chunk: Buffer) => {
      const command = chunk.toString('utf8').trim();
      protocol.push(command);
      const event =
        command === 'HELLO/1'
          ? 'ready'
          : command === 'PING/1'
            ? 'pong'
            : command === 'SHUTDOWN/1'
              ? 'stopped'
              : 'rejected';
      const payload = options.wrongReply
        ? { protocol: 2, event, executionEnabled: false }
        : { protocol: 1, event, executionEnabled: false };
      stdout.write(JSON.stringify(payload) + '\n');
      if (command === 'SHUTDOWN/1') {
        setImmediate(() => {
          exitCode = 0;
          emitter.emit('exit', 0);
        });
      }
    });
    return Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      get exitCode() {
        return exitCode;
      },
      kill: vi.fn(() => {
        exitCode = 1;
        emitter.emit('exit', 1);
        return true;
      }),
    }) as never;
  });

  return { calls, protocol };
}

describe('isolated worker foundation', () => {
  let boundary: BoundaryService;
  let worker: WorkerService;

  beforeEach(() => {
    vi.resetAllMocks();
    boundary = new BoundaryService();
    worker = new WorkerService(boundary);
  });

  afterEach(async () => {
    await worker.onModuleDestroy();
    vi.restoreAllMocks();
  });

  function passPreflight() {
    vi.spyOn(boundary, 'status').mockReturnValue({
      ...boundary.status(),
      state: 'passed',
      checkedAt: new Date().toISOString(),
    });
  }

  it('rejects custom IDs, host mounts and privileged flags', () => {
    const args = workerArguments('gym-dev-hub-worker-00000000-0000-4000-8000-000000000055', ID);
    expect(args).toEqual(
      expect.arrayContaining([
        '--pull=never',
        '--rm',
        '-i',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=65534:65534',
        '--pids-limit=32',
        '--memory=128m',
        '--cpus=0.5',
        ID,
      ]),
    );
    expect(args).not.toContain('--privileged');
    expect(
      args.some(
        (item) => item.startsWith('--mount') || item.startsWith('--volume') || item === '-v',
      ),
    ).toBe(false);
    expect(args.some((item) => item.includes('docker.sock'))).toBe(false);
    expect(() => workerArguments('some-repository/evil', ID)).toThrow();
    expect(() =>
      workerArguments('gym-dev-hub-worker-00000000-0000-4000-8000-000000000055', 'latest'),
    ).toThrow();
  });

  it('requires a labelled immutable image with fixed entrypoint and non-root user', () => {
    expect(validateWorkerImage(ID + '|' + JSON.stringify(CONFIG))).toBe(ID);
    expect(() => validateWorkerImage('sha256:bad|' + JSON.stringify(CONFIG))).toThrow();
    expect(() =>
      validateWorkerImage(ID + '|' + JSON.stringify({ ...CONFIG, User: '0' })),
    ).toThrow();
    expect(() =>
      validateWorkerImage(ID + '|' + JSON.stringify({ ...CONFIG, Entrypoint: ['/bin/sh', '-c'] })),
    ).toThrow();
    expect(() =>
      validateWorkerImage(
        ID +
          '|' +
          JSON.stringify({
            ...CONFIG,
            Labels: { ...CONFIG.Labels, 'org.gym-dev-hub.worker.execution': 'enabled' },
          }),
      ),
    ).toThrow();
  });

  it('fails closed when the preflight has not passed', async () => {
    mockDocker();
    await expect(worker.start()).rejects.toThrow('Preflight');
    expect(callDocker).not.toHaveBeenCalled();
  });

  it('rejects stale preflight results', async () => {
    vi.spyOn(boundary, 'status').mockReturnValue({
      ...boundary.status(),
      state: 'passed',
      checkedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    });
    mockDocker();
    await expect(worker.start()).rejects.toThrow('Preflight');
  });

  it('starts, handshakes, pings and stops a non-executing container', async () => {
    const fake = mockDocker();
    passPreflight();
    const started = await worker.start();
    expect(started).toMatchObject({
      state: 'running',
      protocolVersion: 1,
      executionEnabled: false,
      imageId: ID,
    });
    const inspected = fake.calls.find((call) => call[0] === 'image');
    expect(inspected).toContain(WORKER_IMAGE);
    expect(fake.protocol).toEqual(['HELLO/1']);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain(ID);
    const heart = await worker.ping();
    expect(heart.state).toBe('running');
    expect(heart.lastHeartbeatAt).toBeTruthy();
    const done = await worker.stop();
    expect(done).toMatchObject({ state: 'stopped', executionEnabled: false });
    expect(fake.protocol).toEqual(['HELLO/1', 'PING/1', 'SHUTDOWN/1']);
  });

  it('denies a remote engine even after previous preflight', async () => {
    mockDocker({ remote: true });
    passPreflight();
    await expect(worker.start()).rejects.toThrow('безпечно запустити');
    expect(spawn).not.toHaveBeenCalled();
    expect(worker.status().state).toBe('error');
  });

  it('rejects an image with incorrect labels or privileged user', async () => {
    mockDocker({ badImage: true });
    passPreflight();
    await expect(worker.start()).rejects.toThrow('безпечно запустити');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails on a corrupted worker protocol response', async () => {
    mockDocker({ wrongReply: true });
    passPreflight();
    await expect(worker.start()).rejects.toThrow('безпечно запустити');
    expect(worker.status().state).toBe('error');
  });

  it('does not pass application secrets to the Docker worker', async () => {
    const prev = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-secret';
    try {
      mockDocker();
      passPreflight();
      await worker.start();
      const opts = vi.mocked(spawn).mock.calls[0]?.[2];
      expect(opts?.env?.GITHUB_TOKEN).toBeUndefined();
      expect(opts?.env?.DATABASE_URL).toBeUndefined();
      expect(opts?.shell).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prev;
    }
  });

  it('coalesces multiple concurrent starts rather than creating multiple workers', async () => {
    mockDocker();
    passPreflight();
    const a = worker.start();
    const b = worker.start();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects ping before startup', async () => {
    await expect(worker.ping()).rejects.toThrow('ще не запущено');
  });
});
