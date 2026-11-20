'use client';

import { useEffect, useState } from 'react';
import type {
  WorktreePlan,
  WorktreePlanState,
  WorktreeCreationGrant,
} from '@gym-dev-hub/contracts';

const labels: Record<WorktreePlanState, string> = {
  pending: 'Очікує погодження',
  acknowledged: 'План погоджено',
  revoked: 'Відкликано',
  expired: 'Термін вичерпано',
  creating: 'Створення Git worktree',
  created: 'Worktree створено',
  failed: 'Потребує перевірки Git',
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
  const [operatorSecret, setOperatorSecret] = useState('');
  const [grant, setGrant] = useState<WorktreeCreationGrant | null>(null);
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
  const active = plans.some((item) =>
    ['pending', 'acknowledged', 'creating', 'created'].includes(item.state),
  );

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

  async function authorizeWorktree() {
    if (
      !latest ||
      latest.state !== 'acknowledged' ||
      busy ||
      completed ||
      operatorSecret.length < 32
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${base(sessionId)}/${latest.id}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: latest.fingerprint, operatorSecret }),
        cache: 'no-store',
      });
      if (!response.ok)
        throw new Error('Дозвіл не видано. Перевір локальні налаштування та секрет оператора.');
      setGrant((await response.json()) as WorktreeCreationGrant);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося авторизувати створення.');
    } finally {
      setOperatorSecret('');
      setBusy(false);
    }
  }

  async function materializeWorktree() {
    if (!latest || !grant || latest.state !== 'acknowledged' || busy || completed) return;
    const issued = grant;
    setGrant(null); // Never reuse a one-time grant, even if a request fails.
    setBusy(true);
    setError(null);
    try {
      await fetchPlans(`${base(sessionId)}/${latest.id}/create`, { grantToken: issued.grantToken });
      setPlans(await fetchPlans(base(sessionId)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося створити worktree.');
      try {
        setPlans(await fetchPlans(base(sessionId)));
      } catch {
        /* Keep visible last state. */
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-plan-panel" aria-label="Worktree manifest and approval">
      <div className="ws-boundary-heading">
        <div>
          <div className="overline">WORKTREE AUTHORIZATION · PR #10</div>
          <h3>План окремої робочої області</h3>
        </div>
        {latest && <span className="ws-boundary-state">{labels[latest.state]}</span>}
      </div>
      <p>
        Репозиторій: <strong>{repository}</strong>. План можна окремо авторизувати секретом
        оператора. Створення Git worktree виконується лише після додаткового підтвердження та не
        завантажує файли проєкту.
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
          {latest.baseHeadSha && (
            <div>
              <span>Зафіксований Git commit</span>
              <code>{latest.baseHeadSha}</code>
            </div>
          )}
          <div className="ws-plan-locked">
            Запуск агентів і довільних команд: <strong>вимкнено</strong>. Створення Git worktree —
            лише окрема дозволена дія без checkout файлів.
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
      {latest?.state === 'acknowledged' && !completed && (
        <div className="ws-worktree-authorization">
          <label htmlFor="operator-secret">Секрет локального оператора (не зберігається)</label>
          <input
            id="operator-secret"
            type="password"
            minLength={32}
            autoComplete="off"
            value={operatorSecret}
            onChange={(event) => setOperatorSecret(event.target.value)}
            placeholder="Секрет з DEV_HUB_WORKTREE_OPERATOR_SECRET"
            disabled={busy || Boolean(grant)}
          />
          <button
            type="button"
            className="refresh"
            disabled={busy || operatorSecret.length < 32 || Boolean(grant)}
            onClick={() => void authorizeWorktree()}
          >
            Авторизувати створення
          </button>
          {grant && (
            <div className="ws-worktree-grant">
              <small>
                Дозвіл для коміту <code>{grant.baseHeadSha}</code> до{' '}
                {new Date(grant.expiresAt).toLocaleTimeString('uk-UA')}.
              </small>
              <button
                type="button"
                className="ws-primary"
                disabled={busy}
                onClick={() => void materializeWorktree()}
              >
                Створити Git worktree без checkout файлів
              </button>
            </div>
          )}
        </div>
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
        Погодження плану діє 15 хвилин. Окремий одноразовий дозвіл діє 60 секунд. Нова Git-гілка і
        metadata-only worktree не дають агенту доступу до коду або команд.
      </small>
    </section>
  );
}
