import Link from 'next/link';
import type { GitHubCIState, PullReadiness, ReadinessVerdict } from '@gym-dev-hub/contracts';

interface Props {
  repository: string;
  number: string;
  data: PullReadiness | null;
  error: string | null;
}

const verdicts: Record<ReadinessVerdict, { label: string; detail: string; state: GitHubCIState }> =
  {
    'ready-for-review': {
      label: 'Можна передавати на review',
      detail: 'Відомі перевірки пройшли. Це не автоматичний дозвіл на merge.',
      state: 'success',
    },
    blocked: {
      label: 'Є блокувальні проблеми',
      detail: 'Спочатку потрібно виправити проблеми у PR.',
      state: 'failure',
    },
    pending: {
      label: 'Перевірки ще виконуються',
      detail: 'Онови сторінку після завершення CI.',
      state: 'pending',
    },
    unknown: {
      label: 'Готовність не підтверджена',
      detail: 'Даних недостатньо — перевір GitHub вручну.',
      state: 'unknown',
    },
  };

function statusLabel(state: GitHubCIState): string {
  switch (state) {
    case 'success':
      return 'Пройшов';
    case 'failure':
      return 'Помилка';
    case 'pending':
      return 'Очікує';
    default:
      return 'Невідомо';
  }
}

export function ReadinessView({ repository, number, data, error }: Props) {
  const dashboardUrl = `/?repository=${encodeURIComponent(repository)}`;
  const detailUrl = `/pr/${encodeURIComponent(number)}?repository=${encodeURIComponent(repository)}`;
  const verdict = data ? verdicts[data.verdict] : null;

  return (
    <div className="app">
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="brand-mark">G</span>
          <span>
            <strong>Gym Dev Hub</strong>
            <small>Development workspace</small>
          </span>
        </Link>
        <span className="topbar-badge">Read-only PR checks</span>
      </header>
      <main className="readiness-container">
        <div className="readiness-toolbar">
          <Link className="back-link" href={dashboardUrl}>
            ← Назад до Dashboard
          </Link>
          <Link className="refresh" href={detailUrl}>
            ↻ Оновити
          </Link>
        </div>
        <div className="overline">
          GITHUB / {repository} / PR #{number}
        </div>
        <h1 className="readiness-title">Технічна готовність PR</h1>

        {error && (
          <div className="alert" role="alert">
            <strong>Не вдалося перевірити PR.</strong>
            <span>{error}</span>
          </div>
        )}

        {data && verdict && (
          <>
            <section className="readiness-summary">
              <div>
                <div className="overline">HEAD COMMIT · {data.headSha.slice(0, 12)}</div>
                <h2>
                  #{data.number} · {data.title}
                </h2>
                <p>{verdict.detail}</p>
                <div className="readiness-meta">
                  <span>Base: {data.baseBranch}</span>
                  <span>
                    Mergeability:{' '}
                    {data.mergeable === true
                      ? 'без конфліктів'
                      : data.mergeable === false
                        ? 'блокування'
                        : 'невідомо'}
                  </span>
                  <span>
                    Оновлено:{' '}
                    {new Date(data.fetchedAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}
                  </span>
                </div>
              </div>
              <span className={`verdict verdict-${verdict.state}`}>{verdict.label}</span>
            </section>

            <section className="readiness-stats" aria-label="Огляд перевірок">
              <div className="stat-card">
                <div className="stat-caption">Поточні checks</div>
                <div className="stat-value">{data.checks.length}</div>
                <span className={`state state-${data.checksState}`}>
                  {statusLabel(data.checksState)}
                </span>
              </div>
              <div className="stat-card">
                <div className="stat-caption">Required checks</div>
                <div className="stat-value">
                  {data.policy === 'unavailable' ? '—' : data.requiredChecks.length}
                </div>
                <span className={`state state-${data.requiredState}`}>
                  {statusLabel(data.requiredState)}
                </span>
              </div>
              <div className="stat-card">
                <div className="stat-caption">GitHub PR статус</div>
                <div className="stat-value stat-word">{data.draft ? 'Draft' : 'Open'}</div>
                <div className="stat-detail">{data.mergeableState}</div>
              </div>
            </section>

            <div className="readiness-grid">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <div className="overline">NEXT ACTION</div>
                    <h2>Висновок</h2>
                  </div>
                </div>
                <div className="readiness-reasons">
                  {data.reasons.map((reason) => (
                    <p key={reason}>• {reason}</p>
                  ))}
                  {data.unavailable.length > 0 && (
                    <p className="unavailable-note">
                      Недоступні дані: {data.unavailable.join(', ')}.
                    </p>
                  )}
                  <p className="manual-review">
                    Це перевірка лише отриманих GitHub Checks та класичного branch protection.
                    GitHub Rulesets, погодження review і всі merge-гейти потрібно перевіряти у
                    самому PR. Злиття виконується лише вручну.
                  </p>
                  <a
                    href={data.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="github-action"
                  >
                    Відкрити PR на GitHub ↗
                  </a>
                </div>
              </section>

              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <div className="overline">BRANCH PROTECTION</div>
                    <h2>Required checks</h2>
                  </div>
                </div>
                {data.policy === 'unavailable' ? (
                  <div className="empty">
                    Налаштування branch protection недоступні. Це не означає відсутність required
                    checks.
                  </div>
                ) : data.requiredChecks.length > 0 ? (
                  data.requiredChecks.map((check) => (
                    <div className="readiness-check" key={`${check.name}:${check.appId}`}>
                      <div>
                        <strong>{check.name}</strong>
                        <small>
                          {check.appId ? `GitHub App #${check.appId}` : 'Будь-який provider'}
                        </small>
                      </div>
                      <span className={`state state-${check.state}`}>
                        {statusLabel(check.state)}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="empty">
                    Класичних required checks не знайдено. GitHub Rulesets можуть мати додаткові
                    вимоги.
                  </div>
                )}
              </section>
            </div>

            <section className="panel readiness-checks-panel">
              <div className="panel-heading">
                <div>
                  <div className="overline">LATEST PR HEAD SHA</div>
                  <h2>Check-runs і commit statuses</h2>
                </div>
                <span className="count">{data.checks.length} у відповіді</span>
              </div>
              {data.checks.length > 0 ? (
                data.checks.map((check, index) => (
                  <div
                    className="readiness-check"
                    key={`${check.source}:${check.name}:${check.appId}:${index}`}
                  >
                    <div>
                      <strong>{check.name}</strong>
                      <small>
                        {check.provider} · {check.source} · {check.detail}
                      </small>
                    </div>
                    <span className={`state state-${check.state}`}>{statusLabel(check.state)}</span>
                    {check.url && (
                      <a
                        href={check.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="outbound"
                        aria-label={`GitHub check: ${check.name}`}
                      >
                        ↗
                      </a>
                    )}
                  </div>
                ))
              ) : (
                <div className="empty">
                  Жодної перевірки не отримано. Це не є ознакою успішного CI.
                </div>
              )}
            </section>
            <p className="footer">
              Дані кешуються до 20 секунд. Перед merge звір поточний commit SHA на GitHub. Dev Hub
              ніколи не зливає PR автоматично.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
