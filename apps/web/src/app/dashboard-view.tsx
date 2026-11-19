import Link from 'next/link';
import type { GitHubCIState, GitHubDashboard, GitHubSection } from '@gym-dev-hub/contracts';

interface Props {
  dashboard: GitHubDashboard | null;
  error?: string | null;
  selectedRepository?: string;
}

const fallbackRepositories = ['sauron9521/gym-dev-hub', 'sauron9521/gym-platform'];

function date(value: string): string {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function ciLabel(state: GitHubCIState): string {
  switch (state) {
    case 'success':
      return 'CI пройшов';
    case 'failure':
      return 'CI упав';
    case 'pending':
      return 'CI виконується';
    default:
      return 'CI невідомий';
  }
}

function runState(status: string, conclusion: string | null): GitHubCIState {
  if (status !== 'completed') return 'pending';
  if (conclusion === 'success') return 'success';
  if (['failure', 'timed_out', 'action_required', 'startup_failure'].includes(conclusion ?? '')) {
    return 'failure';
  }
  return 'unknown';
}

function EmptySection({ unavailable, label }: { unavailable: boolean; label: string }) {
  return (
    <div className="empty">
      {unavailable
        ? `GitHub не надав дані для розділу «${label}». Перевірте доступ або ліміти API.`
        : `У вибірці немає записів для розділу «${label}».`}
    </div>
  );
}

function PanelHeading({
  id,
  eyebrow,
  title,
  count,
}: {
  id: string;
  eyebrow: string;
  title: string;
  count: number | null;
}) {
  return (
    <div className="panel-heading" id={id}>
      <div>
        <div className="overline">{eyebrow}</div>
        <h2>{title}</h2>
      </div>
      {count !== null && <span className="count">{count} у вибірці</span>}
    </div>
  );
}

export function DashboardView({ dashboard, error, selectedRepository }: Props) {
  const repositories = dashboard?.repositories ?? fallbackRepositories;
  const current = dashboard?.repository ?? selectedRepository ?? repositories[0];

  const unavailable = (section: GitHubSection) => dashboard?.unavailable.includes(section) ?? false;

  return (
    <div className="app">
      <header className="topbar">
        <Link href="/" className="brand" aria-label="Gym Dev Hub — головна">
          <span className="brand-mark">G</span>
          <span>
            <strong>Gym Dev Hub</strong>
            <small>Development workspace</small>
          </span>
        </Link>
        <div className="topbar-right">
          <span className="mode-dot" />
          <span>GitHub · лише читання</span>
          <span className="topbar-badge">MVP / PR #2</span>
        </div>
      </header>

      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-section-label">РЕПОЗИТОРІЇ</div>
          <nav className="repository-list" aria-label="Вибір репозиторію">
            {repositories.map((repository) => (
              <Link
                key={repository}
                className={`repository-link ${current === repository ? 'active' : ''}`}
                href={`/?repository=${encodeURIComponent(repository)}`}
                aria-current={current === repository ? 'page' : undefined}
              >
                <span className="repository-icon">◇</span>
                <span>{repository.split('/')[1]}</span>
                {current === repository && <span className="repository-active" />}
              </Link>
            ))}
          </nav>
          <div className="sidebar-section-label secondary-label">НАВІГАЦІЯ</div>
          <nav className="section-list" aria-label="Розділи">
            <a href="#pulls">Pull requests</a>
            <a href="#issues">Issues</a>
            <a href="#milestones">Milestones</a>
            <a href="#actions">GitHub Actions</a>
          </nav>
          <div className="sidebar-footer">
            <div className="read-only-mark">◎ Безпечний режим</div>
            <p>Немає операцій запису в GitHub, запуску агентів або автоматичного merge.</p>
          </div>
        </aside>

        <main className="content">
          <div className="breadcrumb">
            WORKSPACE / GITHUB / <span>{current}</span>
          </div>
          <div className="page-heading">
            <div>
              <div className="overline">REPOSITORY OVERVIEW</div>
              <h1>
                Контроль розробки<span className="accent">.</span>
              </h1>
              <p>PR, задачі, етапи та перевірки GitHub в одному місці.</p>
            </div>
            <Link href={`/?repository=${encodeURIComponent(current)}`} className="refresh">
              ↻ Оновити дані
            </Link>
          </div>

          {error && (
            <div className="alert" role="alert">
              <strong>Не вдалося завантажити dashboard.</strong>
              <span>{error}</span>
              <code>pnpm dev</code>
            </div>
          )}

          {dashboard ? (
            <>
              <div className="repo-context">
                <div>
                  <div className="repo-name-row">
                    <a href={dashboard.repositoryUrl} target="_blank" rel="noopener noreferrer">
                      {dashboard.repository} ↗
                    </a>
                    <span className="public-tag">GitHub</span>
                  </div>
                  <p>{dashboard.description ?? 'Репозиторій без опису'}</p>
                </div>
                <div className="meta">
                  main: {dashboard.defaultBranch} · Оновлено {date(dashboard.fetchedAt)}
                </div>
              </div>

              {dashboard.unavailable.length > 0 && (
                <div className="alert" role="status">
                  Частина даних недоступна: {dashboard.unavailable.join(', ')}. Відсутні дані не
                  означають, що записів немає.
                </div>
              )}

              <div className="stats">
                {[
                  {
                    value: dashboard.pulls.length,
                    title: 'Відкриті PR',
                    detail: 'останні 15',
                  },
                  {
                    value: dashboard.issues.length,
                    title: 'Відкриті Issues',
                    detail: 'останні 15 без PR',
                  },
                  {
                    value: dashboard.milestones.length,
                    title: 'Milestones',
                    detail: 'відкриті, до 30',
                  },
                  {
                    value: dashboard.runs.length,
                    title: 'Workflow runs',
                    detail: 'останні 15',
                  },
                ].map((stat, index) => (
                  <div className="stat-card" key={stat.title}>
                    <div className="stat-caption">
                      <span>0{index + 1}</span>
                      {stat.title}
                    </div>
                    <div className="stat-value">
                      {dashboard.unavailable.includes(
                        (['pulls', 'issues', 'milestones', 'runs'] as const)[index],
                      )
                        ? '—'
                        : stat.value}
                    </div>
                    <div className="stat-detail">{stat.detail}</div>
                  </div>
                ))}
              </div>

              <div className="panels">
                <section className="panel" aria-labelledby="pulls-title">
                  <PanelHeading
                    id="pulls"
                    eyebrow="REVIEW PIPELINE"
                    title="Pull requests"
                    count={unavailable('pulls') ? null : dashboard.pulls.length}
                  />
                  <h3 className="sr-only" id="pulls-title">
                    Pull requests
                  </h3>
                  {dashboard.pulls.length ? (
                    dashboard.pulls.map((pr) => (
                      <a
                        key={pr.number}
                        className="item"
                        href={pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <span className="item-symbol">⑂</span>
                        <span className="item-body">
                          <strong>
                            #{pr.number} · {pr.title}
                          </strong>
                          <small>
                            {pr.headBranch} · {pr.author} · {date(pr.updatedAt)}
                          </small>
                        </span>
                        {pr.draft && <span className="state state-neutral">Draft</span>}
                        <span className={`state state-${pr.ci}`}>{ciLabel(pr.ci)}</span>
                        <span className="outbound">↗</span>
                      </a>
                    ))
                  ) : (
                    <EmptySection unavailable={unavailable('pulls')} label="Pull requests" />
                  )}
                  <div className="panel-note">
                    CI оцінюється тільки за останніми отриманими workflow runs із відповідним head
                    SHA. «Невідомий» не означає успіх.
                  </div>
                </section>

                <section className="panel" aria-labelledby="issues-title">
                  <PanelHeading
                    id="issues"
                    eyebrow="TASK BACKLOG"
                    title="Issues"
                    count={unavailable('issues') ? null : dashboard.issues.length}
                  />
                  <h3 className="sr-only" id="issues-title">
                    Issues
                  </h3>
                  {dashboard.issues.length ? (
                    dashboard.issues.map((issue) => (
                      <a
                        key={issue.number}
                        className="item"
                        href={issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <span className="item-symbol">◇</span>
                        <span className="item-body">
                          <strong>
                            #{issue.number} · {issue.title}
                          </strong>
                          <small>
                            {issue.author} · {date(issue.updatedAt)}
                          </small>
                        </span>
                        <span className="item-labels">{issue.labels.slice(0, 2).join(' · ')}</span>
                        <span className="outbound">↗</span>
                      </a>
                    ))
                  ) : (
                    <EmptySection unavailable={unavailable('issues')} label="Issues" />
                  )}
                </section>

                <section className="panel" aria-labelledby="milestones-title">
                  <PanelHeading
                    id="milestones"
                    eyebrow="DELIVERY ROADMAP"
                    title="Milestones"
                    count={unavailable('milestones') ? null : dashboard.milestones.length}
                  />
                  <h3 className="sr-only" id="milestones-title">
                    Milestones
                  </h3>
                  {dashboard.milestones.length ? (
                    dashboard.milestones.map((milestone) => {
                      const total = milestone.openIssues + milestone.closedIssues;
                      const progress = total
                        ? Math.round((milestone.closedIssues / total) * 100)
                        : 0;
                      return (
                        <a
                          key={milestone.number}
                          className="milestone"
                          href={milestone.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <div className="milestone-top">
                            <strong>{milestone.title}</strong>
                            <span>{progress}%</span>
                          </div>
                          <div className="track">
                            <span style={{ width: `${progress}%` }} />
                          </div>
                          <small>
                            {milestone.closedIssues} закрито · {milestone.openIssues} відкрито
                            {milestone.dueOn ? ` · Дедлайн ${date(milestone.dueOn)}` : ''}
                          </small>
                        </a>
                      );
                    })
                  ) : (
                    <EmptySection unavailable={unavailable('milestones')} label="Milestones" />
                  )}
                </section>

                <section className="panel" aria-labelledby="actions-title">
                  <PanelHeading
                    id="actions"
                    eyebrow="CONTINUOUS INTEGRATION"
                    title="GitHub Actions"
                    count={unavailable('runs') ? null : dashboard.runs.length}
                  />
                  <h3 className="sr-only" id="actions-title">
                    GitHub Actions
                  </h3>
                  {dashboard.runs.length ? (
                    dashboard.runs.map((run) => {
                      const state = runState(run.status, run.conclusion);
                      return (
                        <a
                          key={run.id}
                          className="item"
                          href={run.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <span className="item-symbol">⌁</span>
                          <span className="item-body">
                            <strong>{run.name}</strong>
                            <small>
                              {run.branch} · {run.event} · {date(run.createdAt)}
                            </small>
                          </span>
                          <span className={`state state-${state}`}>{ciLabel(state)}</span>
                          <span className="outbound">↗</span>
                        </a>
                      );
                    })
                  ) : (
                    <EmptySection unavailable={unavailable('runs')} label="GitHub Actions" />
                  )}
                </section>
              </div>
            </>
          ) : (
            <div className="panel">
              <div className="empty">
                Запустіть Web та API разом командою <code>pnpm dev</code>. Панель покаже реальні
                дані GitHub, коли API стане доступним.
              </div>
            </div>
          )}
          <footer className="footer">
            Gym Dev Hub · read-only integration · merge залишається за власником репозиторію
          </footer>
        </main>
      </div>
    </div>
  );
}
