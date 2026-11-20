'use client';

import { useEffect, useState } from 'react';
import type { ExecutionBoundaryStatus } from '@gym-dev-hub/contracts';

type State = ExecutionBoundaryStatus | null;

const labels = {
  'not-checked': 'Не перевірено',
  running: 'Виконується',
  passed: 'Пройшов',
  failed: 'Не пройшов',
  unavailable: 'Недоступно',
} as const;

async function readStatus(path: string, post = false): Promise<ExecutionBoundaryStatus> {
  const response = await fetch(`/api/workspace/boundary/${path}`, {
    method: post ? 'POST' : 'GET',
    headers: post ? { 'Content-Type': 'application/json' } : undefined,
    body: post ? '{}' : undefined,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Не вдалося виконати перевірку ізоляції.');
  return (await response.json()) as ExecutionBoundaryStatus;
}

export function BoundaryStatusPanel() {
  const [status, setStatus] = useState<State>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readStatus('status')
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        if (!cancelled) setError('NestJS API недоступний.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run() {
    if (pending) return;
    setPending(true);
    setError(null);
    setStatus((previous) =>
      previous
        ? {
            ...previous,
            state: 'running',
            message: 'Виконується Docker isolation preflight…',
          }
        : previous,
    );
    try {
      setStatus(await readStatus('preflight', true));
    } catch {
      setError('Docker isolation preflight не виконався. Перевір API та Docker Desktop.');
      try {
        setStatus(await readStatus('status'));
      } catch {
        /* Render error state. */
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="ws-boundary-panel" aria-label="Docker execution boundary">
      <div className="ws-boundary-heading">
        <div>
          <div className="overline">EXECUTION BOUNDARY · PR #7</div>
          <h2>Docker Safety Preflight</h2>
        </div>
        <span className={`ws-boundary-state ws-boundary-${status?.state ?? 'not-checked'}`}>
          {labels[status?.state ?? 'not-checked']}
        </span>
      </div>
      <p>{status?.message ?? 'Отримуємо статус Docker isolation.'}</p>
      <div className="ws-boundary-policies">
        <span>Мережа: none</span>
        <span>Root: read-only</span>
        <span>User: non-root</span>
        <span>Capabilities: none</span>
        <span>Host mounts: none</span>
        <span>Memory: 128 MB</span>
      </div>
      {error && (
        <p className="ws-chat-error" role="alert">
          {error}
        </p>
      )}
      <div className="ws-boundary-bottom">
        <div>
          <strong>Виконання агентських команд: вимкнено</strong>
          <small>
            Це перевірка тестового контейнера, а не дозвіл запускати агентів. Навіть успішний тест
            не усуває всіх ризиків контейнеризації.
          </small>
        </div>
        <button type="button" className="ws-primary" disabled={pending} onClick={() => void run()}>
          {pending ? 'Перевіряємо Docker…' : 'Перевірити ізоляцію'}
        </button>
      </div>
      {status?.checkedAt && (
        <small className="ws-boundary-time">
          Остання перевірка:{' '}
          {new Date(status.checkedAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}
        </small>
      )}
    </section>
  );
}
