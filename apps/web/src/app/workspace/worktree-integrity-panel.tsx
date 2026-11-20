'use client';

import { useState } from 'react';
import type { WorktreeIntegrityReport } from '@gym-dev-hub/contracts';
import { WorktreeMountPanel } from './worktree-mount-panel';
import { WorktreeCodeReadPanel } from './worktree-code-read-panel';
import { WorktreeToolPanel } from './worktree-tool-panel';

type Props = { sessionId: string; planId: string; fingerprint?: string };

const labels: Record<WorktreeIntegrityReport['status'], string> = {
  verified: 'Усі файли збігаються з Git',
  mismatch: 'Виявлено зміни або небезпечні об’єкти',
  'not-ready': 'Worktree ще не готовий до перевірки',
};

export function WorktreeIntegrityPanel({ sessionId, planId, fingerprint }: Props) {
  const [report, setReport] = useState<WorktreeIntegrityReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    if (busy) return;
    setBusy(true);
    setReport(null);
    setError(null);
    try {
      const response = await fetch(
        `/api/workspace/sessions/${sessionId}/worktree-plans/${planId}/integrity`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error('Не вдалося перевірити цілісність worktree.');
      setReport((await response.json()) as WorktreeIntegrityReport);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Перевірка недоступна.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-worktree-inspection" aria-label="Перевірка цілісності worktree">
      <div className="overline">POST-HYDRATION INTEGRITY · PR #14</div>
      <h4>Перевірка файлів і майбутнього mount</h4>
      <p>
        Read-only перевірка файлів за Git hash. Вона не запускає Docker, не монтує каталоги та не
        надає Codex дозволів.
      </p>
      <button type="button" className="refresh" disabled={busy} onClick={() => void verify()}>
        {busy ? 'Звіряємо файли…' : 'Звірити з Git'}
      </button>
      {error && (
        <p role="alert" className="ws-chat-error">
          {error}
        </p>
      )}
      {report && (
        <div className="ws-worktree-inspection-result" role="status">
          <strong>{labels[report.status]}</strong>
          <p>
            Перевірено: {report.fileCount} файлів, {report.verifiedBytes.toLocaleString('uk-UA')}{' '}
            байтів.
          </p>
          {report.findings.length > 0 && (
            <ul>
              {report.findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          )}
          <div className="ws-plan-detail">
            <div>
              <span>Майбутній read-only mount</span>
              <code>
                {report.mount.sourcePath} → {report.mount.targetPath}
              </code>
            </div>
            <div>
              <span>Доступ до мережі</span>
              <strong>вимкнено</strong>
            </div>
            <div>
              <span>Реальне монтування</span>
              <strong>вимкнено</strong>
            </div>
            <div>
              <span>Виконання команд агента</span>
              <strong>вимкнено</strong>
            </div>
          </div>
          {report.status === 'verified' && fingerprint && (
            <>
              <WorktreeMountPanel
                key={report.checkedAt}
                sessionId={sessionId}
                report={report}
                fingerprint={fingerprint}
              />
              <WorktreeCodeReadPanel
                key={report.checkedAt + '-read'}
                sessionId={sessionId}
                report={report}
                fingerprint={fingerprint}
              />
              <WorktreeToolPanel
                key={report.checkedAt + '-tool'}
                sessionId={sessionId}
                report={report}
                fingerprint={fingerprint}
              />
            </>
          )}
          <small>
            Підсумок є одноразовим знімком стану. Навіть успішна перевірка не дозволяє mount або
            запуск агента.
          </small>
        </div>
      )}
    </section>
  );
}
