'use client';

import { useEffect, useState } from 'react';
import type { WorktreePlan, WorktreePlanState } from '@gym-dev-hub/contracts';

const labels: Record<WorktreePlanState, string> = {
  pending: 'Очікує погодження',
  acknowledged: 'План погоджено',
  revoked: 'Відкликано',
  expired: 'Термін вичерпано',
};

type Props = {
  sessionId: string;
  repository: string;
  completed: boolean;
};

const base = (sessionId: string) => `/api/workspace/sessions/${sessionId}/worktree-plans`;

async function fetchPlans(
  path: string,
  payload?: Record<string, unknown>,
): Promise<WorktreePlan[]> {
  const response = await fetch(path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: 'no-store',
  });
  if (!response.ok) {
    try {
      const details = (await response.json()) as { message?: string };
      throw new Error(details.message ?? 'Не вдалося виконати операцію з планом.');
    } catch (error) {
      if (error instanceof Error && !error.message.includes('JSON')) throw error;
      throw new Error('Сервіс планів недоступний.');
    }
  }
  const result = (await response.json()) as WorktreePlan[] | WorktreePlan;
  return Array.isArray(result) ? result : [result];
}

export function WorktreePlanPanel({ sessionId, repository, completed }: Props) {
  const [plans, setPlans] = useState<WorktreePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    void fetchPlans(base(sessionId))
      .then((next) => {
        if (!canceled) setPlans(next);
      })
      .catch((reason: unknown) => {
        if (!canceled) setError(reason instanceof Error ? reason.message : 'Плани недоступні.');
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [sessionId]);

  const latest = plans[0] ?? null;
  const active = plans.some((item) => item.state === 'pending' || item.state === 'acknowledged');

  async function perform(action: 'create' | 'acknowledge' | 'revoke') {
    if (busy || completed) return;
    const plan = latest;
    if (action !== 'create' && !plan) return;
    setBusy(true);
    setError(null);
    try {
      const path =
        action === 'create' ? base(sessionId) : `${base(sessionId)}/${plan!.id}/${action}`;
      const payload =
        action === 'acknowledge'
          ? { fingerprint: plan!.fingerprint, confirmation: 'I_APPROVE_THIS_PLAN_ONLY' }
          : {};
      await fetchPlans(path, payload);
      setPlans(await fetchPlans(base(sessionId)));
      setConfirmed(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Операцію не виконано.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-plan-panel" aria-label="Worktree manifest and approval">
      <div className="ws-boundary-heading">
        <div>
          <div className="overline">WORKTREE MANIFEST · PR #9</div>
          <h3>План окремої робочої області</h3>
        </div>
        {latest && <span className="ws-boundary-state">{labels[latest.state]}</span>}
      </div>
      <p>
        Репозиторій: <strong>{repository}</strong>. Створюється лише маніфест; Git-гілки й папки не
        змінюються.
      </p>
      {loading && <p>Отримуємо плани…</p>}
      {!loading && !latest && <p>Для цієї сесії ще немає плану worktree.</p>}
      {latest && (
        <div className="ws-plan-detail">
          <div>
            <span>Початковий репозиторій</span>
            <code>{latest.sourcePath}</code>
          </div>
          <div>
            <span>Майбутній worktree</span>
            <code>{latest.targetPath}</code>
          </div>
          <div>
            <span>Запланована гілка</span>
            <code>{latest.proposedBranch}</code>
          </div>
          <div>
            <span>SHA-256 fingerprint</span>
            <code>{latest.fingerprint}</code>
          </div>
          <div>
            <span>Термін погодження</span>
            <span>
              {latest.expiresAt
                ? new Date(latest.expiresAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
                : 'Не задано'}
            </span>
          </div>
          <div>
            <span>Історія</span>
            <span>{latest.history.map((event) => event.event).join(' → ')}</span>
          </div>
          <div className="ws-plan-locked">
            Права на запуск, запис файлів та Git-операції: <strong>вимкнено</strong>.
          </div>
        </div>
      )}
      {latest?.state === 'pending' && !completed && (
        <label className="ws-plan-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          Підтверджую саме показаний план. Це не дозвіл агенту виконувати команди або створювати
          worktree.
        </label>
      )}
      {error && (
        <p className="ws-chat-error" role="alert">
          {error}
        </p>
      )}
      <div className="ws-worker-actions">
        <button
          type="button"
          className="ws-primary"
          disabled={busy || loading || completed || active}
          onClick={() => void perform('create')}
        >
          Створити план
        </button>
        <button
          type="button"
          className="refresh"
          disabled={busy || !confirmed || completed || latest?.state !== 'pending'}
          onClick={() => void perform('acknowledge')}
        >
          Погодити план
        </button>
        <button
          type="button"
          className="refresh"
          disabled={
            busy || completed || !latest || !['pending', 'acknowledged'].includes(latest.state)
          }
          onClick={() => void perform('revoke')}
        >
          Відкликати
        </button>
      </div>
      <small className="ws-plan-note">
        Погодження діє до 15 хвилин та зберігається лише як локальний запис наміру. Для реального
        створення worktree знадобиться нове явне підтвердження в наступному PR.
      </small>
    </section>
  );
}
