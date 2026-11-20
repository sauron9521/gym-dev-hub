'use client';

import { useState } from 'react';
import type {
  WorktreeIntegrityReport,
  WorktreeToolGrant,
  WorktreeToolResult,
} from '@gym-dev-hub/contracts';

type Props = { sessionId: string; report: WorktreeIntegrityReport; fingerprint: string };

export function WorktreeToolPanel({ sessionId, report, fingerprint }: Props) {
  const [filePath, setFilePath] = useState('');
  const [operatorSecret, setOperatorSecret] = useState('');
  const [approved, setApproved] = useState(false);
  const [grant, setGrant] = useState<WorktreeToolGrant | null>(null);
  const [result, setResult] = useState<WorktreeToolResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/workspace/sessions/${sessionId}/worktree-plans/${report.planId}`;

  async function authorize() {
    if (busy || grant || !approved || !filePath || operatorSecret.length < 32) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(base + '/tool-authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint, tool: 'SHA256_FILE', filePath, operatorSecret }),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error('Дозвіл не видано. Перевір шлях, окремий секрет і Docker preflight.');
      }
      setGrant((await response.json()) as WorktreeToolGrant);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не вдалося погодити інструмент.');
    } finally {
      setOperatorSecret('');
      setBusy(false);
    }
  }

  async function execute() {
    if (!grant || busy) return;
    const token = grant.grantToken;
    setGrant(null);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(base + '/tool-execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantToken: token }),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error('Інструмент відхилено. Перевір Docker, pinned Git snapshot і очищення staging.');
      }
      setResult((await response.json()) as WorktreeToolResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Виконання інструмента недоступне.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-worktree-authorization" aria-label="Дозвіл на фіксований інструмент Docker">
      <div className="overline">CONTROLLED WORKER TOOL · PR #17</div>
      <h4>Інструмент SHA-256 одного файла</h4>
      <p>
        Запускає тільки фіксовану перевірку контрольної суми у тимчасовому Docker worker. Не виконує
        код репозиторію, shell-команди агента, Git push чи merge.
      </p>
      <label htmlFor="worker-tool-path">Відносний шлях до файла (до 8 КБ)</label>
      <input
        id="worker-tool-path"
        type="text"
        maxLength={160}
        value={filePath}
        placeholder="apps/api/src/main.ts"
        disabled={busy || Boolean(grant)}
        onChange={(event) => {
          setFilePath(event.target.value);
          setGrant(null);
          setResult(null);
        }}
        autoComplete="off"
      />
      <label className="ws-plan-confirm">
        <input
          type="checkbox"
          checked={approved}
          disabled={busy || Boolean(grant)}
          onChange={(event) => setApproved(event.target.checked)}
        />
        Погоджую тільки інструмент SHA256_FILE для цього файла в конкретному Git commit. Це не
        дозвіл на виконання довільних команд або зміну коду.
      </label>
      <label htmlFor="worker-tool-secret">Окремий секрет інструментів</label>
      <input
        id="worker-tool-secret"
        type="password"
        autoComplete="off"
        value={operatorSecret}
        placeholder="DEV_HUB_WORKER_TOOL_SECRET"
        disabled={busy || Boolean(grant)}
        onChange={(event) => setOperatorSecret(event.target.value)}
      />
      <button
        type="button"
        className="refresh"
        disabled={busy || Boolean(grant) || !approved || !filePath || operatorSecret.length < 32}
        onClick={() => void authorize()}
      >
        Авторизувати SHA-256
      </button>
      {grant && (
        <div className="ws-worktree-grant">
          <small>
            Дозволено: <code>{grant.filePath}</code> у <code>{grant.baseHeadSha}</code>, до{' '}
            {new Date(grant.expiresAt).toLocaleTimeString('uk-UA')}.
          </small>
          <button
            type="button"
            className="ws-primary"
            disabled={busy}
            onClick={() => void execute()}
          >
            Обчислити SHA-256 і видалити контейнер
          </button>
        </div>
      )}
      {result && (
        <div role="status">
          <p>
            SHA-256 файла <code>{result.filePath}</code>; Docker контейнер завершено.
          </p>
          <pre className="ws-code-read-result">
            <code>{result.sha256}</code>
          </pre>
        </div>
      )}
      {error && (
        <p role="alert" className="ws-chat-error">
          {error}
        </p>
      )}
      <small>
        Потрібні DEV_HUB_ENABLE_WORKTREE_MOUNT=true, DEV_HUB_ENABLE_WORKER_TOOLS=true,
        DEV_HUB_WORKER_TOOL_SECRET та свіжий Docker Safety Preflight. Worker може відмовити в
        читанні файлів з правами 0600.
      </small>
    </div>
  );
}
