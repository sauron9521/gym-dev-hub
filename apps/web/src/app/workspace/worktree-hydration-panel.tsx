'use client';

import { useState } from 'react';
import type { WorktreeHydrationGrant, WorktreePlan } from '@gym-dev-hub/contracts';
import { WorktreeIntegrityPanel } from './worktree-integrity-panel';

interface Props {
  sessionId: string;
  plan: WorktreePlan;
  completed: boolean;
  onRefresh: () => Promise<void>;
}

const base = (sessionId: string, id: string) =>
  `/api/workspace/sessions/${sessionId}/worktree-plans/${id}`;

export function WorktreeHydrationPanel({ sessionId, plan, completed, onRefresh }: Props) {
  const [operatorSecret, setOperatorSecret] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [grant, setGrant] = useState<WorktreeHydrationGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = !completed && plan.state === 'created' && !plan.hydrationState;

  async function authorize() {
    if (!allowed || busy || operatorSecret.length < 32 || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(base(sessionId, plan.id) + '/hydration-authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: plan.fingerprint, operatorSecret }),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error('Hydration не авторизовано. Перевір preflight і секрет оператора.');
      }
      setGrant((await response.json()) as WorktreeHydrationGrant);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося авторизувати hydration.');
    } finally {
      setOperatorSecret('');
      setBusy(false);
    }
  }

  async function hydrate() {
    if (!allowed || busy || !grant) return;
    const issued = grant;
    setGrant(null); // One-time token may never be reused in the browser.
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(base(sessionId, plan.id) + '/hydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantToken: issued.grantToken }),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error('Hydration перервано або заблоковано. Перевір стан worktree.');
      }
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Hydration не завершено.');
      try {
        await onRefresh();
      } catch {
        /* Keep error visible. */
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-worktree-authorization" aria-label="Погодження наповнення worktree">
      <div className="overline">RAW GIT BLOB HYDRATION · PR #13</div>
      <h4>Контрольоване наповнення worktree</h4>
      <p>
        Git-файли записуються в окрему робочу область без checkout filters, hooks або запуску
        агентів. Попередній репозиторій не змінюється.
      </p>
      {plan.hydrationState ? (
        <div className="ws-worktree-inspection-result" role="status">
          <strong>
            {plan.hydrationState === 'completed'
              ? 'Файли скопійовано'
              : plan.hydrationState === 'running'
                ? 'Операція почата, перевір стан'
                : 'Hydration перервано — потрібна ручна перевірка'}
          </strong>
          <p>
            Зафіксовано файлів: {plan.hydrationFiles ?? 0}, байтів: {plan.hydrationBytes ?? 0}.
          </p>
          <small>Повторний запис і автоматичне очищення вимкнені.</small>
        </div>
      ) : (
        <>
          <label className="ws-plan-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || !allowed || Boolean(grant)}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Погоджую запис лише в worktree <code>{plan.targetPath}</code> із Git коміту{' '}
            <code>{plan.baseHeadSha}</code>. Не дозволяю виконання коду чи очищення файлів.
          </label>
          <label htmlFor="hydration-operator-secret">Секрет локального оператора</label>
          <input
            id="hydration-operator-secret"
            type="password"
            autoComplete="off"
            value={operatorSecret}
            onChange={(event) => setOperatorSecret(event.target.value)}
            placeholder="DEV_HUB_WORKTREE_OPERATOR_SECRET"
            disabled={busy || !allowed || Boolean(grant)}
          />
          <button
            type="button"
            className="refresh"
            disabled={
              !allowed || busy || Boolean(grant) || !confirmed || operatorSecret.length < 32
            }
            onClick={() => void authorize()}
          >
            Окремо авторизувати наповнення
          </button>
          {grant && (
            <div className="ws-worktree-grant">
              <small>
                Одноразовий дозвіл до {new Date(grant.expiresAt).toLocaleTimeString('uk-UA')}. Git
                commit: <code>{grant.baseHeadSha}</code>
              </small>
              <button
                type="button"
                className="ws-primary"
                disabled={!allowed || busy}
                onClick={() => void hydrate()}
              >
                Записати Git-файли в worktree
              </button>
            </div>
          )}
        </>
      )}
      {plan.hydrationState === 'completed' && (
        <WorktreeIntegrityPanel key={plan.id} sessionId={sessionId} planId={plan.id} />
      )}
      {error && (
        <p className="ws-chat-error" role="alert">
          {error}
        </p>
      )}
      <small>
        Функцію вимкнено за замовчуванням. Потрібно окремо задати
        DEV_HUB_ENABLE_WORKTREE_HYDRATION=true. Всі дозволи одноразові.
      </small>
    </div>
  );
}
