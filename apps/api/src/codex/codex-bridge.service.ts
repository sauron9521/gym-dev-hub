import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { CodexConnectionStatus } from '@gym-dev-hub/contracts';

class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface RunningTurn {
  threadId: string;
  turnId: string | null;
  text: string;
  itemIds: Set<string>;
  done: (result: { text: string; status: 'completed' | 'failed' | 'interrupted' }) => void;
  onText: (text: string) => void;
  timeout: NodeJS.Timeout;
  aborted: boolean;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

function codexEnvironment(): NodeJS.ProcessEnv {
  // Never inherit Dev Hub's GitHub credentials, database URLs, or other
  // application secrets into an AI-controlled subprocess.
  const allowed = [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'SystemRoot',
    'WINDIR',
    'CODEX_HOME',
    'LANG',
    'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function executablePath(): string {
  const configured = process.env.CODEX_EXECUTABLE?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error('CODEX_EXECUTABLE must be an absolute file path.');
    }
    return configured;
  }
  if (process.platform === 'win32') {
    // Native binary distributed with the global npm installation.
    // Override CODEX_EXECUTABLE for other installation layouts.
    if (!process.env.APPDATA) throw new Error('APPDATA is not configured.');
    return join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    );
  }
  return 'codex';
}

@Injectable()
export class CodexBridgeService implements OnModuleDestroy {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: CodexConnectionStatus = {
    state: 'disconnected',
    message: 'Codex ще не підключений.',
    connectedAt: null,
  };
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, Pending>();
  private readonly activeThreads = new Set<string>();
  private readonly turns = new Map<string, RunningTurn>();
  private connecting: Promise<CodexConnectionStatus> | null = null;
  private readonly timeoutMs = 12_000;
  private readonly maxBufferSize = 512 * 1024;

  status(): CodexConnectionStatus {
    return { ...this.state };
  }

  async connect(): Promise<CodexConnectionStatus> {
    if (this.state.state === 'ready' && this.child) return this.status();
    if (this.connecting) return this.connecting;
    this.state = {
      state: 'connecting',
      message: 'Підключення до локального Codex…',
      connectedAt: null,
    };
    const startup = this.startConnection();
    this.connecting = startup;
    try {
      return await startup;
    } finally {
      this.connecting = null;
    }
  }

  private async startConnection(): Promise<CodexConnectionStatus> {
    try {
      const child = spawn(executablePath(), ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: codexEnvironment(),
      });
      this.child = child;
      this.buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onData(chunk));
      child.stdout.on('error', () => this.disconnectWithError('Помилка потоку відповіді Codex.'));
      child.stdin.on('error', () => this.disconnectWithError('Codex припинив приймати запити.'));
      // Do not emit CLI stderr: it can contain sensitive local configuration.
      child.stderr.on('error', () => this.disconnectWithError('Помилка потоку Codex CLI.'));
      child.stderr.resume();
      child.on('error', () => this.disconnectWithError('Не вдалося запустити Codex CLI.'));
      child.on('exit', () => this.disconnectWithError('Codex app-server припинив роботу.'));
      await this.request('initialize', {
        clientInfo: { name: 'gym_dev_hub', title: 'Gym Dev Hub', version: '0.1.0' },
      });
      this.send({ method: 'initialized', params: {} });
      if (!this.child || this.child.exitCode !== null) throw new Error('Codex exited');
      this.state = {
        state: 'ready',
        message: 'Codex app-server підключений. AI-завдання не запускаються.',
        connectedAt: new Date().toISOString(),
      };
      return this.status();
    } catch {
      this.disconnectWithError('Не вдалося підключити Codex. Перевір встановлення CLI та вхід.');
      throw new ServiceUnavailableException(this.state.message);
    }
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex stdin unavailable');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex request timed out'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.send({ id, method, params });
      } catch {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error('Codex connection lost'));
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.maxBufferSize) {
      this.disconnectWithError('Перевищено розмір повідомлення Codex.');
      return;
    }
    let separator = this.buffer.indexOf('\n');
    while (separator >= 0) {
      const line = this.buffer.slice(0, separator).trim();
      this.buffer = this.buffer.slice(separator + 1);
      if (line) this.receive(line);
      separator = this.buffer.indexOf('\n');
    }
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
      if (!message || typeof message !== 'object') return;
    } catch {
      this.disconnectWithError('Codex надіслав некоректну JSON-RPC відповідь.');
      return;
    }

    const id = message.id;
    if (typeof message.method === 'string' && id === undefined) {
      this.onNotification(message.method, message.params);
    }
    if (typeof id === 'number' && this.pending.has(id)) {
      const task = this.pending.get(id)!;
      clearTimeout(task.timeout);
      this.pending.delete(id);
      if (message.error) {
        const error = message.error as { code?: number; message?: string };
        task.reject(new CodexRpcError(error.code ?? -1, error.message ?? 'Codex rejected request'));
      } else task.resolve(message.result);
      return;
    }
    // Server-initiated actions/approvals are NEVER automatically authorized.
    if ((typeof id === 'number' || typeof id === 'string') && typeof message.method === 'string') {
      try {
        this.send({
          id,
          error: { code: -32601, message: 'Operation not supported in read-only adapter' },
        });
      } catch {
        this.disconnectWithError('Codex connection lost while rejecting an operation.');
      }
    }
  }

  private onNotification(method: string, raw: unknown): void {
    const params = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    if (!threadId) return;
    const turn = this.turns.get(threadId);
    if (!turn) return;
    const turnId =
      typeof params.turnId === 'string'
        ? params.turnId
        : params.turn && typeof params.turn === 'object'
          ? (params.turn as Record<string, unknown>).id
          : null;
    if (typeof turnId === 'string') {
      if (turn.turnId && turn.turnId !== turnId) return;
      turn.turnId = turnId;
    }

    if (method === 'item/agentMessage/delta' && !turn.aborted) {
      if (typeof params.delta === 'string') {
        const itemId = String(params.itemId ?? '');
        turn.itemIds.add(itemId);
        turn.text = (turn.text + params.delta).slice(0, 20_000);
        turn.onText(turn.text);
      }
    } else if (method === 'item/completed' && !turn.aborted) {
      const item =
        params.item && typeof params.item === 'object'
          ? (params.item as Record<string, unknown>)
          : {};
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        const itemId = String(item.id ?? '');
        if (!turn.itemIds.has(itemId)) {
          turn.text = (turn.text + item.text).slice(0, 20_000);
          turn.onText(turn.text);
        }
      }
    } else if (method === 'item/started') {
      const item =
        params.item && typeof params.item === 'object'
          ? (params.item as Record<string, unknown>)
          : {};
      // Extra stop-gap: a read-only sandbox alone allows some read-only shell tools.
      // Interrupt unexpectedly started tools instead of accepting their output.
      if (
        [
          'commandExecution',
          'fileChange',
          'mcpToolCall',
          'dynamicToolCall',
          'webSearch',
          'collabAgentToolCall',
        ].includes(String(item.type))
      ) {
        turn.aborted = true;
        if (turn.turnId) {
          void this.request('turn/interrupt', { threadId, turnId: turn.turnId }).catch(
            () => undefined,
          );
        }
      }
    } else if (method === 'turn/completed') {
      const details =
        params.turn && typeof params.turn === 'object'
          ? (params.turn as Record<string, unknown>)
          : {};
      const status =
        details.status === 'completed' && !turn.aborted
          ? 'completed'
          : details.status === 'interrupted' || turn.aborted
            ? 'interrupted'
            : 'failed';
      clearTimeout(turn.timeout);
      this.turns.delete(threadId);
      turn.done({ text: turn.text, status });
    }
  }

  async startReadOnlyTurn(
    threadId: string,
    text: string,
    onText: (response: string) => void,
  ): Promise<{ text: string; status: 'completed' | 'failed' | 'interrupted' }> {
    if (!this.activeThreads.has(threadId) || this.state.state !== 'ready') {
      throw new ServiceUnavailableException('Спочатку підключи Codex thread.');
    }
    if (this.turns.has(threadId)) {
      throw new ServiceUnavailableException('У цьому Codex thread вже виконується запит.');
    }
    let finished!: (result: {
      text: string;
      status: 'completed' | 'failed' | 'interrupted';
    }) => void;
    const completion = new Promise<{
      text: string;
      status: 'completed' | 'failed' | 'interrupted';
    }>((resolve) => {
      finished = resolve;
    });
    const timeout = setTimeout(() => {
      const turn = this.turns.get(threadId);
      if (!turn) return;
      turn.aborted = true;
      if (turn.turnId) {
        void this.request('turn/interrupt', { threadId, turnId: turn.turnId }).catch(
          () => undefined,
        );
      }
      this.turns.delete(threadId);
      finished({ text: turn.text, status: 'interrupted' });
    }, 120_000);
    const turn: RunningTurn = {
      threadId,
      turnId: null,
      text: '',
      itemIds: new Set(),
      done: finished,
      onText,
      timeout,
      aborted: false,
    };
    this.turns.set(threadId, turn);

    try {
      const result = (await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      })) as { turn?: { id?: unknown } };
      if (typeof result?.turn?.id === 'string' && !turn.turnId) {
        turn.turnId = result.turn.id;
      }
    } catch {
      clearTimeout(timeout);
      this.turns.delete(threadId);
      finished({ text: turn.text, status: 'failed' });
    }
    return completion;
  }

  private disconnectWithError(message: string): void {
    const child = this.child;
    this.child = null;
    this.state = { state: 'error', message, connectedAt: null };
    for (const task of this.pending.values()) {
      clearTimeout(task.timeout);
      task.reject(new Error('Codex disconnected'));
    }
    this.pending.clear();
    this.activeThreads.clear();
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timeout);
      turn.done({ text: turn.text, status: 'failed' });
    }
    this.turns.clear();
    if (child && child.exitCode === null) child.kill();
  }

  async linkThread(
    sessionId: string,
    previousId: string | null,
  ): Promise<{ id: string; reused: boolean }> {
    await this.connect();
    const directory = join(process.cwd(), '.local', 'codex-sessions', sessionId);
    await mkdir(directory, { recursive: true });

    // A thread without its first turn has no Codex rollout on disk yet.
    // Reuse it while our app-server process is alive, instead of sending
    // a thread/resume request that would fail with "no rollout found".
    if (previousId && this.activeThreads.has(previousId)) {
      return { id: previousId, reused: true };
    }

    const settings = {
      cwd: directory,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      // Text-only chat: disable optional tool surfaces. The sandbox remains
      // read-only even if Codex ignores a feature flag.
      config: {
        web_search: 'disabled',
        agents: { enabled: false },
        features: {
          shell_tool: false,
          unified_exec: false,
          browser_use: false,
          browser_use_external: false,
          plugins: false,
        },
      },
      baseInstructions:
        'You are an AI chat assistant. Answer questions in text only. Never execute commands, inspect files, use tools, browse, delegate, or modify anything. If asked to access local resources, state that this mode cannot.',
    };
    const start = async (): Promise<{ id: string; reused: boolean }> => {
      const output = (await this.request('thread/start', settings)) as {
        thread?: { id?: unknown };
      } | null;
      const id = output?.thread?.id;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{4,128}$/.test(id)) {
        throw new Error('Invalid thread ID from Codex');
      }
      this.activeThreads.add(id);
      return { id, reused: false };
    };

    try {
      if (!previousId) return await start();

      try {
        const output = (await this.request('thread/resume', {
          ...settings,
          threadId: previousId,
          excludeTurns: true,
        })) as { thread?: { id?: unknown } } | null;

        if (output?.thread?.id !== previousId) {
          throw new Error('Unexpected resumed thread ID');
        }
        this.activeThreads.add(previousId);
        return { id: previousId, reused: true };
      } catch (error) {
        // Empty threads cannot be resumed across process restarts because
        // Codex has not persisted a rollout until the first turn. There is
        // no conversation to recover, so create a new empty thread safely.
        if (
          error instanceof CodexRpcError &&
          error.code === -32600 &&
          /no rollout found for thread id/i.test(error.message)
        ) {
          return await start();
        }
        throw error;
      }
    } catch {
      throw new ServiceUnavailableException(
        'Не вдалося створити або відновити Codex thread у безпечному режимі.',
      );
    }
  }

  onModuleDestroy(): void {
    const child = this.child;
    this.child = null;
    for (const task of this.pending.values()) {
      clearTimeout(task.timeout);
      task.reject(new Error('Dev Hub stopped'));
    }
    this.pending.clear();
    this.activeThreads.clear();
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timeout);
      turn.done({ text: turn.text, status: 'failed' });
    }
    this.turns.clear();
    if (child && child.exitCode === null) child.kill();
  }
}
