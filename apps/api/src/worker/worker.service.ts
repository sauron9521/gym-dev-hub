import {
  ConflictException,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IsolatedWorkerStatus } from '@gym-dev-hub/contracts';
import { BoundaryService, callDocker, dockerEnvironment } from '../boundary/boundary.service.js';

export const WORKER_IMAGE = 'gym-dev-hub-worker:v1';
const EXPECTED_ENTRYPOINT = JSON.stringify(['/bin/sh', '/opt/gym-dev-hub/worker.sh']);
const PREFLIGHT_MAX_AGE_MS = 5 * 60 * 1000;

export function workerArguments(containerName: string, imageId: string): string[] {
  if (!/^gym-dev-hub-worker-[0-9a-f-]{36}$/.test(containerName)) {
    throw new Error('Invalid worker name');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new Error('Invalid image digest');
  }
  return [
    'run',
    '--rm',
    '-i',
    '--pull=never',
    '--name',
    containerName,
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=32',
    '--memory=128m',
    '--cpus=0.5',
    '--user=65534:65534',
    '--ipc=none',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    '--stop-timeout=3',
    imageId,
  ];
}

export function validateWorkerImage(value: string): string {
  const separator = value.indexOf('|');
  const imageId = value.slice(0, separator);
  if (separator < 0 || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new Error('Invalid Docker image ID');
  }
  let config: {
    Labels?: Record<string, string>;
    Entrypoint?: string[];
    User?: string;
  };
  try {
    config = JSON.parse(value.slice(separator + 1)) as typeof config;
  } catch {
    throw new Error('Invalid Docker image configuration');
  }
  if (
    !config ||
    config.Labels?.['org.gym-dev-hub.worker.protocol'] !== '1' ||
    config.Labels?.['org.gym-dev-hub.worker.execution'] !== 'disabled' ||
    JSON.stringify(config.Entrypoint) !== EXPECTED_ENTRYPOINT ||
    config.User !== '65534:65534'
  ) {
    throw new Error('Untrusted worker image configuration');
  }
  return imageId;
}

interface Reply {
  protocol: number;
  event: string;
  executionEnabled: boolean;
}
type PendingReply = {
  expected: Reply['event'];
  resolve: () => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

@Injectable()
export class WorkerService implements OnModuleDestroy {
  private statusValue: IsolatedWorkerStatus = {
    state: 'not-started',
    message: 'Ізольований worker ще не запущено.',
    containerName: null,
    imageId: null,
    startedAt: null,
    lastHeartbeatAt: null,
    protocolVersion: 1,
    executionEnabled: false,
  };
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private waiter: PendingReply | null = null;
  private starting: Promise<IsolatedWorkerStatus> | null = null;
  private stopping: Promise<IsolatedWorkerStatus> | null = null;

  constructor(private readonly boundary: BoundaryService) {}

  status(): IsolatedWorkerStatus {
    return { ...this.statusValue };
  }

  start(): Promise<IsolatedWorkerStatus> {
    if (this.starting) return this.starting;
    if (this.statusValue.state === 'running') return Promise.resolve(this.status());
    if (this.process) {
      return Promise.reject(new ConflictException('Попередній Docker worker ще завершується.'));
    }

    const check = this.boundary.status();
    if (
      check.state !== 'passed' ||
      !check.checkedAt ||
      !Number.isFinite(Date.parse(check.checkedAt)) ||
      Date.now() - Date.parse(check.checkedAt) > PREFLIGHT_MAX_AGE_MS ||
      Date.parse(check.checkedAt) > Date.now()
    ) {
      return Promise.reject(
        new ConflictException('Спочатку пройди актуальний Docker Safety Preflight.'),
      );
    }

    this.statusValue = {
      ...this.statusValue,
      state: 'starting',
      message: 'Перевіряємо Docker Engine, образ та протокол worker…',
    };
    const operation = this.launch()
      .catch(() => {
        const child = this.process;
        this.process = null;
        child?.stdin.end();
        child?.kill();
        this.clearWaiter();
        this.statusValue = {
          ...this.statusValue,
          state: 'error',
          message:
            'Не вдалося безпечно запустити Docker worker. Перевір локальний image та Docker Desktop.',
        };
        throw new ServiceUnavailableException(this.statusValue.message);
      })
      .finally(() => {
        this.starting = null;
      });
    this.starting = operation;
    return operation;
  }

  private async launch(): Promise<IsolatedWorkerStatus> {
    const endpoint = await callDocker(
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      8_000,
    );
    const local =
      process.platform === 'win32'
        ? endpoint.startsWith('npipe:////./pipe/')
        : endpoint.startsWith('unix://');
    if (!local) throw new Error('Remote Docker denied');
    if ((await callDocker(['info', '--format', '{{.OSType}}'], 8_000)) !== 'linux') {
      throw new Error('Not a Linux Engine');
    }

    const imageInfo = await callDocker(
      ['image', 'inspect', WORKER_IMAGE, '--format', '{{.Id}}|{{json .Config}}'],
      8_000,
    );
    const imageId = validateWorkerImage(imageInfo);
    const containerName = `gym-dev-hub-worker-${randomUUID()}`;
    const args = workerArguments(containerName, imageId);

    const child = spawn('docker', args, {
      shell: false,
      windowsHide: true,
      env: dockerEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    this.buffer = '';
    this.statusValue = {
      ...this.statusValue,
      containerName,
      imageId,
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (part: string) => this.consume(part));
    child.stderr.resume(); // stderr may contain Docker host paths: never expose it.
    child.on('error', () => this.processEnded(child));
    child.on('exit', () => this.processEnded(child));
    child.stdin.on('error', () => this.processEnded(child));
    child.stdout.on('error', () => this.processEnded(child));

    await this.exchange('HELLO/1', 'ready', 12_000);
    if (this.process !== child) throw new Error('Docker worker exited');
    this.statusValue = {
      ...this.statusValue,
      state: 'running',
      message: 'Контейнер готовий до heartbeat. Запуск AI-команд вимкнено.',
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };
    return this.status();
  }

  private exchange(
    message: 'HELLO/1' | 'PING/1' | 'SHUTDOWN/1',
    expected: Reply['event'],
    timeoutMs = 4_000,
  ): Promise<void> {
    const child = this.process;
    if (!child || child.stdin.destroyed || this.waiter) {
      throw new ConflictException('Docker worker не готовий до наступного повідомлення.');
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.failPending(new Error('Worker protocol timeout'));
      }, timeoutMs);
      this.waiter = { expected, resolve, reject, timeout };
      child.stdin.write(message + '\n', 'utf8', (error) => {
        if (error) this.failPending(new Error('Worker transport failed'));
      });
    });
  }

  private consume(part: string): void {
    this.buffer += part;
    if (this.buffer.length > 4096) {
      this.failPending(new Error('Invalid worker output length'));
      this.process?.kill();
      return;
    }
    let lineEnd = this.buffer.indexOf('\n');
    while (lineEnd >= 0) {
      const line = this.buffer.slice(0, lineEnd).trim();
      this.buffer = this.buffer.slice(lineEnd + 1);
      let reply: Partial<Reply>;
      try {
        reply = JSON.parse(line) as Partial<Reply>;
      } catch {
        this.failPending(new Error('Invalid worker JSON'));
        this.process?.kill();
        return;
      }
      const waiter = this.waiter;
      if (
        !waiter ||
        reply.protocol !== 1 ||
        reply.event !== waiter.expected ||
        reply.executionEnabled !== false
      ) {
        this.failPending(new Error('Unexpected worker response'));
        this.process?.kill();
        return;
      }
      this.waiter = null;
      clearTimeout(waiter.timeout);
      waiter.resolve();
      lineEnd = this.buffer.indexOf('\n');
    }
  }

  private failPending(error: Error): void {
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }

  private clearWaiter(): void {
    this.failPending(new Error('Worker stopped'));
  }

  private processEnded(child: ChildProcessWithoutNullStreams): void {
    if (this.process !== child) return;
    this.process = null;
    this.clearWaiter();
    if (this.statusValue.state === 'stopping') {
      this.statusValue = {
        ...this.statusValue,
        state: 'stopped',
        message: 'Docker worker зупинено.',
      };
    } else {
      this.statusValue = {
        ...this.statusValue,
        state: 'error',
        message: 'Worker несподівано зупинився або втрачено з’єднання.',
      };
    }
  }

  async ping(): Promise<IsolatedWorkerStatus> {
    if (this.statusValue.state !== 'running') {
      throw new ConflictException('Worker ще не запущено.');
    }
    try {
      await this.exchange('PING/1', 'pong', 4_000);
      this.statusValue = { ...this.statusValue, lastHeartbeatAt: new Date().toISOString() };
      return this.status();
    } catch {
      this.process?.kill();
      this.statusValue = {
        ...this.statusValue,
        state: 'error',
        message: 'Heartbeat worker завершився помилкою.',
      };
      throw new ServiceUnavailableException(this.statusValue.message);
    }
  }

  stop(): Promise<IsolatedWorkerStatus> {
    if (this.stopping) return this.stopping;
    if (!this.process) {
      return Promise.resolve(this.status());
    }
    if (this.statusValue.state !== 'running') {
      throw new ConflictException('Worker поки не готовий до зупинки.');
    }
    this.statusValue = {
      ...this.statusValue,
      state: 'stopping',
      message: 'Зупиняємо контейнер…',
    };
    const operation = this.shutdown().finally(() => {
      this.stopping = null;
    });
    this.stopping = operation;
    return operation;
  }

  private async shutdown(): Promise<IsolatedWorkerStatus> {
    const child = this.process;
    if (!child) return this.status();
    try {
      await this.exchange('SHUTDOWN/1', 'stopped', 4_000);
      child.stdin.end();
      if (child.exitCode === null) {
        await new Promise<void>((resolve, reject) => {
          const onExit = () => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            child.off('exit', onExit);
            reject(new Error('Worker exit timeout'));
          }, 4_000);
          child.once('exit', onExit);
        });
      }
      this.process = null;
      this.statusValue = {
        ...this.statusValue,
        state: 'stopped',
        message: 'Docker worker завершив роботу.',
      };
      return this.status();
    } catch {
      child.kill();
      this.process = null;
      this.statusValue = {
        ...this.statusValue,
        state: 'error',
        message: 'Worker не вдалося завершити штатно. Перевір контейнери Docker.',
      };
      throw new ServiceUnavailableException(this.statusValue.message);
    }
  }

  async onModuleDestroy(): Promise<void> {
    const child = this.process;
    if (!child) return;
    if (this.statusValue.state === 'running') {
      try {
        await this.stop();
        return;
      } catch {
        // Best effort: the container has no mounts or network and --rm.
      }
    }
    child.stdin.end();
    child.kill();
  }
}
