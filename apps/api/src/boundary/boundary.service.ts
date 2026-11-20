import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import type { ExecutionBoundaryStatus } from '@gym-dev-hub/contracts';

export const PROBE_IMAGE =
  'alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2';

// This is a fixed diagnostic program, never a user/AI-supplied command.
// The host filesystem and Docker socket are NOT mounted into the container.
const FIXED_PROBE = [
  'test "$(id -u)" != "0"',
  '! (touch /devhub-should-stay-read-only 2>/dev/null)',
  'touch /tmp/devhub-probe',
  'rm /tmp/devhub-probe',
  'printf BOUNDARY_OK',
].join(' && ');

const POLICY: ExecutionBoundaryStatus['policy'] = {
  image: PROBE_IMAGE,
  network: 'none',
  rootFilesystem: 'read-only',
  user: 'unprivileged',
  capabilities: 'none',
  privileges: 'no-new-privileges',
  hostMounts: 'none',
  dockerSocket: 'not-mounted',
  memoryMb: 128,
  cpus: 0.5,
  pids: 32,
};

export function probeArguments(name: string): string[] {
  if (!/^gym-dev-hub-probe-[0-9a-f-]{36}$/.test(name)) {
    throw new Error('Invalid probe identifier');
  }
  return [
    'run',
    '--rm',
    '--pull=never',
    '--name',
    name,
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
    PROBE_IMAGE,
    'sh',
    '-c',
    FIXED_PROBE,
  ];
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  // No GitHub, Codex, API or database credentials in the Docker CLI process.
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function callDocker(args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: dockerEnvironment(),
    });
    let done = false;
    let output = '';
    let stderr = '';
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output.trim());
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('Docker CLI timeout'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(0, 2048);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Never send raw Docker stderr back to the browser: it may include paths.
      stderr = (stderr + chunk.toString('utf8')).slice(0, 256);
    });
    child.on('error', () => finish(new Error('Docker CLI unavailable')));
    child.on('exit', (code) => {
      finish(
        code === 0 ? undefined : new Error(stderr ? 'Docker execution failed' : 'Docker exited'),
      );
    });
  });
}

@Injectable()
export class BoundaryService {
  private state: ExecutionBoundaryStatus = {
    state: 'not-checked',
    checkedAt: null,
    message: 'Перевірку Docker isolation ще не виконано.',
    mode: 'docker-linux-preflight',
    agentExecutionEnabled: false,
    policy: { ...POLICY },
  };
  private pending: Promise<ExecutionBoundaryStatus> | null = null;

  status(): ExecutionBoundaryStatus {
    return { ...this.state, policy: { ...this.state.policy } };
  }

  runPreflight(): Promise<ExecutionBoundaryStatus> {
    if (this.pending) return this.pending;
    this.state = {
      ...this.state,
      state: 'running',
      message: 'Перевіряємо локальний Docker Engine та ізольований контейнер…',
    };
    const pending = this.perform().finally(() => {
      this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  private async perform(): Promise<ExecutionBoundaryStatus> {
    let state: ExecutionBoundaryStatus['state'] = 'failed';
    let message = 'Docker не підтвердив заявлені обмеження контейнера.';

    try {
      const endpoint = await callDocker(
        ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
        8_000,
      );
      const isLocal =
        process.platform === 'win32'
          ? endpoint.startsWith('npipe:////./pipe/')
          : endpoint.startsWith('unix://');
      if (!isLocal) {
        state = 'unavailable';
        message = 'Docker налаштовано на не локальний Engine. Використання заборонено.';
      } else {
        const os = await callDocker(['info', '--format', '{{.OSType}}'], 8_000);
        if (os !== 'linux') {
          state = 'unavailable';
          message = 'Потрібен Docker Engine у режимі Linux containers.';
        } else {
          const result = await callDocker(probeArguments(`gym-dev-hub-probe-${randomUUID()}`));
          if (result === 'BOUNDARY_OK') {
            state = 'passed';
            message =
              'Тестовий контейнер підтвердив read-only root, непривілейованого користувача й writable tmpfs.';
          }
        }
      }
    } catch {
      state = 'unavailable';
      message =
        'Docker або закріплений Alpine image недоступні. Перевір Docker Desktop і локальний image.';
    }
    this.state = {
      ...this.state,
      state,
      checkedAt: new Date().toISOString(),
      message,
      // Preflight is informational. No endpoint exists to run agents.
      agentExecutionEnabled: false,
    };
    return this.status();
  }
}
