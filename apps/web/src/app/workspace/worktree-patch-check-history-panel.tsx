'use client';

import { useState } from 'react';
import type {
  WorktreePatchCheckHistory,
  WorktreePatchCheckHistoryEntry,
  WorktreePatchCheckHistoryStatus,
} from '@gym-dev-hub/contracts';

const statuses: Record<WorktreePatchCheckHistoryStatus, string> = {
  authorized: 'Дозвіл виданий',
  expired: 'Дозвіл прострочено / неактивний',
  running: 'Виконується',
  'cancel-requested': 'Запитано скасування',
  passed: 'Успішно',
  failed: 'Неуспішно',
  canceled: 'Скасовано',
  interrupted: 'Результат невідомий після перезапуску',
};

const recipes = {
  API_TYPECHECK: 'API · TypeScript',
  API_TEST: 'API · Vitest',
  WEB_TYPECHECK: 'Web · TypeScript',
  WEB_TEST: 'Web · Vitest',
} as const;

const formatTime = (value: string | null): string =>
  value ? new Date(value).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) : '—';

function statusText(entry: WorktreePatchCheckHistoryEntry): string {
  return statuses[entry.status];
}

type Props = { sessionId: string; planId: string };

export function WorktreePatchCheckHistoryPanel({ sessionId, planId }: Props) {
  const [operatorSecret, setOperatorSecret] = useState('');
  const [history, setHistory] = useState<WorktreePatchCheckHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadHistory() {
    if (loading || operatorSecret.length < 32) return;
    const secret = operatorSecret;
    setOperatorSecret(''); // Never persist the secret after the request.
    setError(null);
    setLoading(true);
    setHistory(null); // Prevent stale results from looking current on failure.
    try {
      const response = await fetch(
        `/api/workspace/sessions/${sessionId}/worktree-plans/${planId}/patch-check-history`,
        {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operatorSecret: secret }),
        },
      );
      if (!response.ok) {
        throw new Error('Журнал недоступний. Перевір секрет Docker check та локальний opt-in.');
      }
      const value = (await response.json()) as WorktreePatchCheckHistory;
      if (
        value.sessionId !== sessionId ||
        value.planId !== planId ||
        value.readOnly !== true ||
        value.rawLogsAvailable !== false ||
        value.commandsEnabled !== false ||
        value.commitEnabled !== false ||
        value.pushEnabled !== false ||
        value.mergeEnabled !== false ||
        !Array.isArray(value.items) ||
        value.items.length > 30
      ) {
        throw new Error('Сервер повернув неприпустимий звіт історії.');
      }
      setHistory(value);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не вдалося відкрити журнал.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="ws-worktree-authorization" aria-label="Історія перевірок Docker">
      <div className="overline">PATCH CHECK AUDIT · PR #66</div>
      <h4>Історія TypeScript / Vitest перевірок</h4>
      <p>
        Окремий приватний журнал для цього worktree: лише статус, рецепт, час і короткий результат.
        Жодних сирих логів, токенів або повторного запуску. Зберігається після перезапуску Hub.
      </p>
      <label htmlFor="ws-patch-check-history-secret">Секрет перегляду Docker checks</label>
      <input
        id="ws-patch-check-history-secret"
        type="password"
        autoComplete="off"
        value={operatorSecret}
        disabled={loading}
        placeholder="DEV_HUB_PATCH_CHECK_OPERATOR_SECRET"
        onChange={(event) => setOperatorSecret(event.target.value)}
      />
      <button
        type="button"
        className="refresh"
        disabled={operatorSecret.length < 32 || loading}
        onClick={() => void loadHistory()}
      >
        {loading ? 'Завантаження історії…' : history ? 'Оновити журнал' : 'Показати журнал'}
      </button>
      {error && (
        <p role="alert" className="ws-chat-error">
          {error}
        </p>
      )}
      {history && (
        <div role="status" className="ws-plan-detail">
          <p>
            Знайдено запусків і дозволів: <strong>{history.total}</strong>. Оновлено:{' '}
            {formatTime(history.checkedAt)}.
          </p>
          {history.limited && (
            <small>Показано останні 30 записів. Повний журнал зберігається лише локально.</small>
          )}
          {!history.items.length && <p>Ще немає жодного Docker check для цього плану.</p>}
          {history.items.map((item) => (
            <div key={item.grantId} className="ws-worktree-grant">
              <div>
                <strong>{recipes[item.recipeId]}</strong> · <span>{statusText(item)}</span>
              </div>
              <small>
                Дозвіл: {formatTime(item.authorizedAt)} · Початок: {formatTime(item.startedAt)} ·
                Завершення: {formatTime(item.finishedAt)}
              </small>
              {item.durationMs !== null && (
                <small>
                  Тривалість: {(item.durationMs / 1000).toFixed(1)} с
                  {item.stdoutBytes !== null ? ` · stdout: ${item.stdoutBytes} Б` : ''}
                  {item.stderrBytes !== null ? ` · stderr: ${item.stderrBytes} Б` : ''}
                </small>
              )}
              <small>
                Run: <code>{item.runId ?? 'не запускався'}</code> · Commit:{' '}
                <code>{item.sourceCommit.slice(0, 12)}</code> · SHA патча:{' '}
                <code>{item.proposedSha256.slice(0, 12)}</code>
              </small>
            </div>
          ))}
          <small>
            «Результат невідомий» означає, що в журналі є початок запуску, але немає підтвердженого
            завершення. Це не доказ успіху або помилки тестів.
          </small>
        </div>
      )}
    </section>
  );
}
