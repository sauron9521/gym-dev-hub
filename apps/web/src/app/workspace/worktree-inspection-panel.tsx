'use client';

import { useState } from 'react';
import type { WorktreeInspection } from '@gym-dev-hub/contracts';

interface Props {
  sessionId: string;
  planId: string;
}

const states: Record<WorktreeInspection['state'], string> = {
  'ready-for-hydration': 'Готовий до наступного етапу',
  'needs-review': 'Потрібна ручна перевірка',
  missing: 'Папку не знайдено',
};

export function WorktreeInspectionPanel({ sessionId, planId }: Props) {
  const [report, setReport] = useState<WorktreeInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function inspect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const response = await fetch(
        `/api/workspace/sessions/${sessionId}/worktree-plans/${planId}/inspection`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error('Не вдалося перевірити Git worktree.');
      const value = (await response.json()) as WorktreeInspection;
      setReport(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Перевірка недоступна.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-worktree-inspection" aria-label="Перевірка Git worktree">
      <h4>Перевірка worktree та відновлення</h4>
      <p>
        Читає Git-метадані та список файлів, не змінюючи їх.
        Checkout, cleanup і доступ агента залишаються вимкненими.
      </p>
      <button type="button" className="refresh" disabled={busy} onClick={() => void inspect()}>
        {busy ? 'Перевіряємо…' : 'Перевірити готовність'}
      </button>
      {error && <p role="alert" className="ws-chat-error">{error}</p>}
      {report && (
        <div className="ws-worktree-inspection-result" role="status">
          <strong>{states[report.state]}</strong>
          <p>Файлів у Git tree: {report.fileCount}; розмір: {report.totalBytes.toLocaleString('uk-UA')} байт.</p>
          <p>{report.metadataOnly ? 'Worktree містить лише .git-метадані.' : 'Worktree потребує огляду перед checkout.'}</p>
          {report.findings.length > 0 && (
            <ul>
              {report.findings.map((finding) => <li key={finding}>{finding}</li>)}
            </ul>
          )}
          <small>Перевірено: {new Date(report.checkedAt).toLocaleString('uk-UA')}. Цей звіт не є дозволом запускати дії.</small>
        </div>
      )}
    </div>
  );
}
