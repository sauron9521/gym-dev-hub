'use client';

import { useState } from 'react';
import type {
  WorktreeHydrationGrant,
  WorktreeHydrationInspection,
  WorktreePlan,
} from '@gym-dev-hub/contracts';

type Props = {
  sessionId: string;
  plan: WorktreePlan;
  onUpdate: () => Promise<void>;
};

export function WorktreeHydrationPanel({ sessionId, plan, onUpdate }: Props) {
  const [report, setReport] = useState<WorktreeHydrationInspection | null>(null);
  const [secret, setSecret] = useState('');
  const [grant, setGrant] = useState<WorktreeHydrationGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/workspace/sessions/${sessionId}/worktree-plans/${plan.id}/hydration`;

  async function inspect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setGrant(null);
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error('Перевірка Git worktree недоступна.');
      setReport((await response.json()) as WorktreeHydrationInspection);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося перевірити worktree.');
    } finally {
      setBusy(false);
    }
  }

  async function action(kind: 'authorize' | 'apply') {
    if (busy || report?.state !== 'ready') return;
    if (kind === 'authorize' && (!report.fingerprint || secret.length < 32)) return;
    if (kind === 'apply' && !grant) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint + '/' + kind, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'authorize'
          ? { fingerprint: report.fingerprint, operatorSecret: secret }
          : { grantToken: grant!.grantToken }),
      });
      if (!response.ok) {
        throw new Error(kind === 'authorize'
          ? 'Дозвіл відхилено. Перевір налаштування та секрет оператора.'
          : 'Наповнення не вдалося. Перевір стан Git вручну.');
      }
      if (kind === 'authorize') {
        setGrant((await response.json()) as WorktreeHydrationGrant);
      } else {
        setGrant(null);
        setReport(null);
        await onUpdate();
      }
    } catch (reason) {
      if (kind === 'apply') {
        setGrant(null); // Never retry with an already consumed token.
        await onUpdate().catch(() => undefined);
      }
      setError(reason instanceof Error ? reason.message : 'Помилка авторизації.');
    } finally {
      setSecret('');
      setBusy(false);
    }
  }

  return (
    <section className="ws-worktree-authorization" aria-label="Контрольоване наповнення worktree">
      <div className="overline">SAFE GIT BLOBS · PR #11</div>
      <strong>Наповнення робочої області</strong>
      <small>
        У Git worktree записуються лише звичайні файли з підтвердженого коміту.
        Symlink, submodule, небезпечні шляхи й надмірно великі дерева блокуються.
        Команди агента та Git hooks не запускаються.
      </small>
      {plan.state === 'created' && (
        <button type="button" className="refresh" disabled={busy} onClick={() => void inspect()}>
          Перевірити вміст і безпеку
        </button>
      )}
      {report && (
        <div className="ws-plan-detail">
          <strong>Стан: {report.state}</strong>
          <small>{report.message}</small>
          <small>Файлів: {report.fileCount} · Байти: {report.totalBytes}</small>
          {report.fingerprint && <code>{report.fingerprint}</code>}
        </div>
      )}
      {report?.state === 'ready' && plan.state === 'created' && (
        <>
          <label htmlFor="worktree-hydrate-secret">Окремий дозвіл оператора (не зберігається)</label>
          <input
            id="worktree-hydrate-secret"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            disabled={busy || Boolean(grant)}
          />
          <button
            type="button"
            className="refresh"
            disabled={busy || secret.length < 32 || Boolean(grant)}
            onClick={() => void action('authorize')}
          >
            Погодити наповнення файлів
          </button>
          {grant && (
            <div className="ws-worktree-grant">
              <small>Одноразовий дозвіл для {grant.fileCount} файлів, до {new Date(grant.expiresAt).toLocaleTimeString('uk-UA')}.</small>
              <button type="button" className="ws-primary" disabled={busy} onClick={() => void action('apply')}>
                Наповнити Git worktree
              </button>
            </div>
          )}
        </>
      )}
      {plan.state === 'hydrated' && <small>Файли підготовлено. Повторне наповнення вимкнене.</small>}
      {['hydrating', 'hydrate-failed'].includes(plan.state) && (
        <small>Операція перервана або не завершена. Нічого не видалятиметься автоматично.
          Перевір Git worktree вручну.</small>
      )}
      {error && <p role="alert" className="ws-chat-error">{error}</p>}
    </section>
  );
}
