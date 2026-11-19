import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CodexBridgeService } from '../src/codex/codex-bridge.service.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  error?: unknown;
};

function mockAppServer(options: { resumeMissing?: boolean } = {}) {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Message[] = [];
  let exitCode: number | null = null;

  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) {
      const msg = JSON.parse(line) as Message;
      requests.push(msg);
      if (msg.method === 'initialize') {
        stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'fake/0.1' } }) + '\n');
      } else if (msg.method === 'thread/resume' && options.resumeMissing) {
        stdout.write(
          JSON.stringify({
            id: msg.id,
            error: {
              code: -32600,
              message: 'no rollout found for thread id ' + msg.params?.threadId,
            },
          }) + '\n',
        );
      } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
        const id = msg.method === 'thread/resume' ? msg.params?.threadId : '019b4dc2-test-thread';
        stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id } } }) + '\n');
      }
    }
  });

  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    get exitCode() {
      return exitCode;
    },
    kill() {
      exitCode = 0;
      events.emit('exit', 0);
      return true;
    },
  });

  vi.mocked(spawn).mockReturnValue(child as never);
  return { requests, stdout };
}

describe('CodexBridgeService protocol', () => {
  let service: CodexBridgeService;

  beforeEach(() => {
    service = new CodexBridgeService();
  });

  afterEach(async () => {
    service.onModuleDestroy();
    vi.clearAllMocks();
    await rm(
      join(process.cwd(), '.local', 'codex-sessions', '00000000-0000-4000-8000-000000000055'),
      {
        force: true,
        recursive: true,
      },
    );
  });

  it('performs initialize handshake once and never starts an AI turn', async () => {
    const server = mockAppServer();
    const connected = await service.connect();
    expect(connected.state).toBe('ready');
    expect((await service.connect()).state).toBe('ready');
    expect(server.requests.filter((item) => item.method === 'initialize')).toHaveLength(1);
    expect(server.requests).toContainEqual({ method: 'initialized', params: {} });
    expect(server.requests.some((item) => item.method === 'turn/start')).toBe(false);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('creates and reuses active per-session threads without a turn', async () => {
    const server = mockAppServer();
    const sessionId = '00000000-0000-4000-8000-000000000055';
    const created = await service.linkThread(sessionId, null);
    expect(created).toEqual({ id: '019b4dc2-test-thread', reused: false });
    expect(await service.linkThread(sessionId, created.id)).toEqual({
      id: created.id,
      reused: true,
    });
    const start = server.requests.find((item) => item.method === 'thread/start');
    const resume = server.requests.find((item) => item.method === 'thread/resume');
    expect(start?.params).toMatchObject({
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    expect(String(start?.params?.cwd)).toContain(sessionId);
    expect(resume).toBeUndefined();
    expect(server.requests.some((item) => item.method === 'turn/start')).toBe(false);
    expect(server.requests.some((item) => item.method === 'thread/shellCommand')).toBe(false);
  });

  it('replaces an empty non-persisted thread after a restart instead of failing', async () => {
    const server = mockAppServer({ resumeMissing: true });
    const result = await service.linkThread(
      '00000000-0000-4000-8000-000000000055',
      'old-empty-thread',
    );
    expect(result).toEqual({ id: '019b4dc2-test-thread', reused: false });
    expect(server.requests.some((item) => item.method === 'thread/resume')).toBe(true);
    expect(server.requests.some((item) => item.method === 'thread/start')).toBe(true);
    expect(server.requests.some((item) => item.method === 'turn/start')).toBe(false);
  });

  it('refuses unsolicited server-side approval requests', async () => {
    const server = mockAppServer();
    await service.connect();
    server.stdout.write(
      JSON.stringify({
        id: 900,
        method: 'item/commandExecution/requestApproval',
        params: { command: ['echo', 'unauthorized'] },
      }) + '\n',
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(server.requests).toContainEqual({
      id: 900,
      error: { code: -32601, message: 'Operation not supported in read-only adapter' },
    });
  });

  it('reports CLI startup failures without leaking terminal output', async () => {
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(events, {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      kill() {
        return true;
      },
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const promise = service.connect();
    events.emit('error', new Error('SENSITIVE PATH/PRIVATE TOKEN'));
    await expect(promise).rejects.toThrow('Не вдалося підключити Codex');
    expect(service.status().state).toBe('error');
    expect(service.status().message).not.toContain('SENSITIVE');
  });
});
