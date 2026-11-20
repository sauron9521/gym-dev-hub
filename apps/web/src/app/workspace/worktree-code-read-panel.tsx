'use client';

import { useState } from 'react';
import type {
  WorktreeCodeReadGrant,
  WorktreeCodeReadResult,
  WorktreeIntegrityReport,
} from '@gym-dev-hub/contracts';

type Props = {
  sessionId: string;
  report: WorktreeIntegrityReport;
  fingerprint: string;
};

export function WorktreeCodeReadPanel({ sessionId, report, fingerprint }: Props) {
  const [filePath, setFilePath] = useState('');
  const [operatorSecret, setOperatorSecret] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [grant, setGrant] = useState<WorktreeCodeReadGrant | null>(null);
  const [result, setResult] = useState<WorktreeCodeReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/workspace/sessions/${sessionId}/worktree-plans/${report.planId}`;

  async function authorize() {
    if (busy || grant || !acknowledged || operatorSecret.length < 32 || !filePath) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(base + '/code-read-authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint, operatorSecret, filePath }),
        cache: 'no-store',
      });
      if (!response.ok)
        throw new Error('Читання не дозволено. Перевір шлях, секрет та Docker preflight.');
      setGrant((await response.json()) as WorktreeCodeReadGrant);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося погодити читання.');
    } finally {
      setOperatorSecret('');
      setBusy(false);
    }
  }

  async function readFile() {
    if (!grant || busy) return;
    const token = grant.grantToken;
    setGrant(null); // A single attempted request consumes this grant.
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(base + '/code-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantToken: token }),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(
          'Не вдалося прочитати файл. UID 65534 може не мати доступу до файлів з правами 0600.',
        );
      }
      setResult((await response.json()) as WorktreeCodeReadResult);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Відмовлено в читанні.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-worktree-authorization" aria-label="Дозвіл на читання одного файла">
      <div className="overline">ONE-FILE SCOPED READ · PR #16</div>
      <h4>Прочитати один файл у Docker</h4>
      <p>
        Окремий одноразовий дозвіл для конкретного файла до 8 КБ. Немає доступу до команд, зміни
        коду, мережі або постійного контейнера. Codex не запускається.
      </p>
      <label htmlFor="scoped-read-path">Відносний шлях у worktree</label>
      <input
        id="scoped-read-path"
        type="text"
        value={filePath}
        onChange={(event) => {
          setFilePath(event.target.value);
          setGrant(null);
          setResult(null);
        }}
        placeholder="apps/api/src/main.ts"
        maxLength={160}
        autoComplete="off"
        disabled={busy || Boolean(grant)}
      />
      <label className="ws-plan-confirm">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy || Boolean(grant)}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        Погоджую читання тільки цього файла з перевіреного Git commit. Це не дозвіл запускати
        агента, виконувати shell-команди або записувати файли.
      </label>
      <label htmlFor="scoped-read-secret">Локальний секрет оператора</label>
      <input
        id="scoped-read-secret"
        type="password"
        autoComplete="off"
        value={operatorSecret}
        onChange={(event) => setOperatorSecret(event.target.value)}
        disabled={busy || Boolean(grant)}
        placeholder="DEV_HUB_WORKTREE_OPERATOR_SECRET"
      />
      <button
        type="button"
        className="refresh"
        disabled={
          busy || Boolean(grant) || !acknowledged || !filePath || operatorSecret.length < 32
        }
        onClick={() => void authorize()}
      >
        Авторизувати читання одного файла
      </button>
      {grant && (
        <div className="ws-worktree-grant">
          <small>
            Тільки <code>{grant.filePath}</code> у commit <code>{grant.baseHeadSha}</code>, до{' '}
            {new Date(grant.expiresAt).toLocaleTimeString('uk-UA')}.
          </small>
          <button
            className="ws-primary"
            type="button"
            onClick={() => void readFile()}
            disabled={busy}
          >
            Прочитати та видалити контейнер
          </button>
        </div>
      )}
      {result && (
        <div role="status">
          <p>
            Прочитано <code>{result.filePath}</code>; тимчасовий контейнер видалено.
          </p>
          <pre className="ws-code-read-result">
            <code>{result.content}</code>
          </pre>
        </div>
      )}
      {error && (
        <p role="alert" className="ws-chat-error">
          {error}
        </p>
      )}
      <small>
        Потрібні DEV_HUB_ENABLE_WORKTREE_MOUNT=true, DEV_HUB_ENABLE_SCOPED_CODE_READ=true, новий
        worker image і свіжий Safety Preflight. Файли з правами 0600 можуть бути недоступні для
        непривілейованого worker.
      </small>
    </div>
  );
}
