'use client';

import { useEffect, useState } from 'react';
import type { WorkflowReadinessReport } from '@gym-dev-hub/contracts';

const stateLabels = {
  configured: 'Передумови налаштовані',
  blocked: 'Потрібно налаштувати',
  unknown: 'Невідомо',
} as const;

async function loadPreflight(): Promise<WorkflowReadinessReport> {
  const response = await fetch('/api/workspace/workflow-readiness', {
    cache: 'no-store',
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? 'У локально запущеному Hub немає цього маршруту. Онови код і перезапусти Web/API.'
        : 'Не вдалося перевірити готовність локального Hub.',
    );
  const result = (await response.json()) as WorkflowReadinessReport;
  if (
    result.repository !== 'sauron9521/gym-dev-hub' ||
    result.readOnly !== true ||
    result.writesPerformed !== false ||
    result.endToEndVerified !== false ||
    !Array.isArray(result.gates)
  ) {
    throw new Error('Некоректна відповідь перевірки workflow.');
  }
  return result;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 12) : 'Невідомий';
}

export function WorkflowReadinessPanel() {
  const [report, setReport] = useState<WorkflowReadinessReport | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPreflight()
      .then((value) => {
        if (!cancelled) setReport(value);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'API недоступний.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      setReport(await loadPreflight());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося оновити звіт.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="ws-boundary-panel" aria-label="Готовність наскрізного workflow">
      <div className="ws-boundary-heading">
        <div>
          <div className="overline">END-TO-END WORKFLOW · READ-ONLY · PR #71</div>
          <h2>Перевірка готовності до тестового запуску</h2>
        </div>
        <span className="ws-boundary-state ws-boundary-not-checked">
          {report ? `${report.configuredCount}/${report.totalCount}` : 'Не перевірено'}
        </span>
      </div>
      <p>
        Перевіряємо, чи доступні потрібні локальні дозволи та чи збігається Git HEAD із GitHub main.
        Жодні секрети або токени не показуються; перевірка не створює файлів, гілок чи PR.
      </p>
      <div className="ws-boundary-policies">
        <span>Локальний HEAD: {shortSha(report?.source.localHeadSha ?? null)}</span>
        <span>GitHub main: {shortSha(report?.source.githubMainSha ?? null)}</span>
        <span>Read-only: так</span>
        <span>Реальний E2E: не перевірено</span>
      </div>
      {report && (
        <ol className="ws-readiness-steps">
          {report.gates.map((gate) => (
            <li key={gate.id}>
              <strong>{gate.title}</strong>
              <span> — {stateLabels[gate.state]}</span>
              <p>{gate.note}</p>
              {gate.missingKeys.length > 0 && (
                <small>
                  Потрібно налаштувати у приватному локальному .env:{' '}
                  <code>{gate.missingKeys.join(', ')}</code>
                </small>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="ws-boundary-bottom">
        <div>
          <strong>
            {report?.preconditionsSatisfied
              ? 'Передумови налаштовані — потрібен окремий ручний E2E тест'
              : 'Повний тест поки не готовий'}
          </strong>
          <small>
            Перевірка конфігурації не підтверджує права GitHub, проходження Docker-тестів або успіх
            CI. Кожен етап потребує окремого дозволу та перевірки.
          </small>
        </div>
        <button
          className="ws-primary"
          type="button"
          disabled={pending}
          onClick={() => void refresh()}
        >
          {pending ? 'Перевіряємо…' : 'Перевірити ще раз'}
        </button>
      </div>
      {report && (
        <small className="ws-boundary-time">
          Остання перевірка:{' '}
          {new Date(report.checkedAt).toLocaleString('uk-UA', {
            timeZone: 'Europe/Kyiv',
          })}
        </small>
      )}
      {error && (
        <p className="ws-chat-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
