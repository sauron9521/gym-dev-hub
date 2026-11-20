'use client';

import { useState } from 'react';
import type {
  WorktreeIntegrityReport,
  WorktreeMountGrant,
  WorktreeMountProbeResult,
} from '@gym-dev-hub/contracts';

type Props = {
  sessionId: string;
  report: WorktreeIntegrityReport;
  fingerprint: string;
};

const base = (sessionId: string, planId: string) =>
  `/api/workspace/sessions/${sessionId}/worktree-plans/${planId}`;

export function WorktreeMountPanel({ sessionId, report, fingerprint }: Props) {
  const [operatorSecret, setOperatorSecret] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [grant, setGrant] = useState<WorktreeMountGrant | null>(null);
  const [result, setResult] = useState<WorktreeMountProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function authorize() {
    if (busy || !acknowledged || operatorSecret.length < 32 || grant) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(base(sessionId, report.planId) + '/mount-authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fingerprint,
          operatorSecret,
        }),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error('Дозвіл не видано. Перевір секрет і свіжий Docker Safety Preflight.');
      }
      setGrant((await response.json()) as WorktreeMountGrant);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося погодити mount.');
    } finally {
      setOperatorSecret('');
      setBusy(false);
    }
  }

  async function probe() {
    if (!grant || busy) return;
    const issued = grant;
    setGrant(null); // Never reuse a token, including after an HTTP error.
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(base(sessionId, report.planId) + '/mount-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantToken: issued.grantToken }),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error('Docker mount не підтверджено; переконайся, що контейнер не залишився.');
      }
      setResult((await response.json()) as WorktreeMountProbeResult);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Docker mount недоступний.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-worktree-authorization" aria-label="Погодження тимчасового Docker mount">
      <div className="overline">EPHEMERAL READ-ONLY WORKER · PR #15</div>
      <h4>Тимчасовий read-only Docker mount</h4>
      <p>
        За окремим дозволом перевіряє mount у контейнері без мережі, а тоді зупиняє контейнер.
        Codex, виконання команд і постійні mounts вимкнено.
      </p>
      <div className="ws-plan-detail">
        <div>
          <span>Локальна папка</span>
          <code>{report.mount.sourcePath}</code>
        </div>
        <div>
          <span>Всередині worker</span>
          <code>/workspace (read-only)</code>
        </div>
        <div>
          <span>Контейнер</span>
          <span>окремий короткоживучий тест</span>
        </div>
      </div>
      {result?.state === 'verified' && (
        <p role="status">
          Docker mount перевірено, контейнер завершено й видалено. Дозвіл на команди агента:{' '}
          <strong>немає</strong>.
        </p>
      )}
      {!result && (
        <>
          <label className="ws-plan-confirm">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy || Boolean(grant)}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            Погоджую тільки тимчасове read-only монтування цього worktree. Це не дозвіл на виконання
            Codex або зміни коду.
          </label>
          <label htmlFor="mount-operator-secret">Локальний секрет оператора</label>
          <input
            id="mount-operator-secret"
            type="password"
            autoComplete="off"
            value={operatorSecret}
            onChange={(event) => setOperatorSecret(event.target.value)}
            placeholder="DEV_HUB_WORKTREE_OPERATOR_SECRET"
            disabled={busy || Boolean(grant)}
          />
          <button
            className="refresh"
            type="button"
            disabled={busy || !acknowledged || operatorSecret.length < 32 || Boolean(grant)}
            onClick={() => void authorize()}
          >
            Авторизувати тимчасовий mount
          </button>
          {grant && (
            <div className="ws-worktree-grant">
              <small>
                Дозвіл для Git commit <code>{grant.baseHeadSha}</code>. Діє до{' '}
                {new Date(grant.expiresAt).toLocaleTimeString('uk-UA')}.
              </small>
              <button
                type="button"
                className="ws-primary"
                disabled={busy}
                onClick={() => void probe()}
              >
                Перевірити Docker mount та завершити контейнер
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="ws-chat-error">
          {error}
        </p>
      )}
      <small>
        Потрібні DEV_HUB_ENABLE_WORKTREE_MOUNT=true і свіжий Docker Safety Preflight. Токен
        одноразовий, діє 60 секунд і не зберігається.
      </small>
    </div>
  );
}
