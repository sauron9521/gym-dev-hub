'use client';

import { useEffect, useState } from 'react';
import type { IsolatedWorkerStatus } from '@gym-dev-hub/contracts';

const titles: Record<IsolatedWorkerStatus['state'], string> = {
  'not-started': 'Не запущено',
  starting: 'Запуск',
  running: 'Працює',
  stopping: 'Зупинка',
  stopped: 'Зупинено',
  error: 'Помилка',
};

async function requestWorker(
  action: 'status' | 'start' | 'ping' | 'stop',
): Promise<IsolatedWorkerStatus> {
  const post = action !== 'status';
  const response = await fetch(`/api/workspace/worker/${action}`, {
    method: post ? 'POST' : 'GET',
    headers: post ? { 'Content-Type': 'application/json' } : undefined,
    body: post ? '{}' : undefined,
    cache: 'no-store',
  });
  if (!response.ok) {
    let message = 'Docker worker недоступний.';
    try {
      const result = (await response.json()) as { message?: string };
      message = result.message ?? message;
    } catch {
      // The API may have restarted while worker was running.
    }
    throw new Error(message);
  }
  return (await response.json()) as IsolatedWorkerStatus;
}

export function WorkerStatusPanel() {
  const [status, setStatus] = useState<IsolatedWorkerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const update = () => {
      void requestWorker('status')
        .then((next) => {
          if (!stopped) setStatus(next);
        })
        .catch(() => {
          if (!stopped) setError('Не вдалося отримати статус worker.');
        });
    };
    update();
    const interval = setInterval(update, 5000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, []);

  async function act(action: 'start' | 'ping' | 'stop') {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await requestWorker(action));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося виконати дію.');
      try {
        setStatus(await requestWorker('status'));
      } catch {
        /* keep last known */
      }
    } finally {
      setBusy(false);
    }
  }

  const running = status?.state === 'running';
  const canStart = !!status && ['not-started', 'stopped', 'error'].includes(status.state);

  return (
    <section className="ws-worker-panel" aria-label="Ізольований Docker worker">
      <div className="ws-boundary-heading">
        <div>
          <div className="overline">WORKER LIFECYCLE · PR #8</div>
          <h2>Isolated Agent Worker</h2>
        </div>
        <span className={`ws-boundary-state ${running ? 'ws-boundary-passed' : ''}`}>
          {titles[status?.state ?? 'not-started']}
        </span>
      </div>
      <p>{status?.message ?? 'Отримуємо стан локального worker.'}</p>
      <div className="ws-boundary-policies">
        <span>Протокол v1</span>
        <span>HELLO / PING / SHUTDOWN</span>
        <span>No shell commands</span>
        <span>No network</span>
        <span>No host mounts</span>
      </div>
      {error && (
        <p className="ws-chat-error" role="alert">
          {error}
        </p>
      )}
      <div className="ws-worker-actions">
        <button
          className="ws-primary"
          type="button"
          disabled={busy || !canStart}
          onClick={() => void act('start')}
        >
          Запустити worker
        </button>
        <button
          className="refresh"
          type="button"
          disabled={busy || !running}
          onClick={() => void act('ping')}
        >
          Перевірити зв’язок
        </button>
        <button
          className="refresh"
          type="button"
          disabled={busy || !running}
          onClick={() => void act('stop')}
        >
          Зупинити worker
        </button>
      </div>
      <div className="ws-worker-footer">
        <strong>Виконання агентських задач: вимкнено</strong>
        <small>
          Worker не запускає Codex та не отримує файлів Gym Platform. Для старту потрібен свіжий
          успішний Docker Safety Preflight і локально зібраний образ.
        </small>
        {status?.lastHeartbeatAt && (
          <small>
            Heartbeat:{' '}
            {new Date(status.lastHeartbeatAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}
          </small>
        )}
      </div>
    </section>
  );
}
