'use client';

import Link from 'next/link';
import { CodexChatPanel } from './codex-chat-panel';
import { BoundaryStatusPanel } from './boundary-status-panel';
import { WorkerStatusPanel } from './worker-status-panel';
import { WorktreePlanPanel } from './worktree-plan-panel';
import { useEffect, useState, type FormEvent } from 'react';
import type {
  AgentSession,
  AgentSessionStatus,
  AgentSessionSummary,
  WorkspaceOverview,
  CodexConnectionStatus,
  CodexSessionBinding,
} from '@gym-dev-hub/contracts';

interface Props {
  initial: WorkspaceOverview;
  initialError: string | null;
}

const statusLabels: Record<AgentSessionStatus, string> = {
  planned: 'Заплановано',
  'in-progress': 'У роботі',
  review: 'Очікує review',
  completed: 'Завершено',
};

function shortDate(input: string): string {
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Kyiv',
  }).format(new Date(input));
}

function summarize(session: AgentSession): AgentSessionSummary {
  const { messages: _messages, ...rest } = session;
  void _messages;
  return rest;
}

async function requestJson<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
  const response = await fetch(`/api/workspace/${path}`, {
    method,
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: 'no-store',
  });
  if (!response.ok) {
    let description = 'Запит не виконано';
    try {
      const error = (await response.json()) as { message?: string | string[] };
      description = Array.isArray(error.message)
        ? error.message.join(', ')
        : error.message || description;
    } catch {
      // Local API can be temporarily unavailable while restarting.
    }
    throw new Error(description);
  }
  return (await response.json()) as T;
}

export function WorkspaceClient({ initial, initialError }: Props) {
  const [sessions, setSessions] = useState(initial.sessions);
  const [repositories, setRepositories] = useState(initial.repositories);
  const [details, setDetails] = useState<Record<string, AgentSession>>({});
  const [tabs, setTabs] = useState<string[]>(initial.sessions[0] ? [initial.sessions[0].id] : []);
  const [activeId, setActiveId] = useState<string | null>(initial.sessions[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [repository, setRepository] = useState(initial.repositories[0] ?? '');
  const [note, setNote] = useState('');
  const [scopedDraft, setScopedDraft] = useState<{ sessionId: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [codexNotice, setCodexNotice] = useState<string | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexConnectionStatus>({
    state: 'disconnected',
    message: 'Codex ще не підключений.',
    connectedAt: null,
  });

  const active = activeId ? details[activeId] : null;
  const activeSummary = sessions.find((session) => session.id === activeId);

  useEffect(() => {
    if (!activeId || details[activeId]) return;
    let cancelled = false;
    requestJson<AgentSession>(`sessions/${activeId}`)
      .then((result) => {
        if (!cancelled) {
          setDetails((previous) => ({ ...previous, [result.id]: result }));
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Не вдалося завантажити сесію.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, details]);

  useEffect(() => {
    let cancelled = false;
    requestJson<CodexConnectionStatus>('codex/status')
      .then((result) => {
        if (!cancelled) setCodexStatus(result);
      })
      .catch(() => {
        /* Status is optional until NestJS starts. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function applySession(session: AgentSession) {
    setDetails((previous) => ({ ...previous, [session.id]: session }));
    setSessions((previous) =>
      [...previous.filter((item) => item.id !== session.id), summarize(session)].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    );
  }

  function openTab(id: string) {
    setTabs((current) => (current.includes(id) ? current : [...current, id]));
    setActiveId(id);
    setError(null);
  }

  function closeTab(id: string) {
    const remaining = tabs.filter((item) => item !== id);
    setTabs(remaining);
    if (activeId === id) setActiveId(remaining[remaining.length - 1] ?? null);
  }

  async function refresh() {
    setBusy(true);
    try {
      const result = await requestJson<WorkspaceOverview>('sessions');
      setSessions(result.sessions);
      setRepositories(result.repositories);
      setDetails({});
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Оновлення не вдалося.');
    } finally {
      setBusy(false);
    }
  }

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const result = await requestJson<AgentSession>('sessions', 'POST', {
        title,
        repository,
        task,
      });
      applySession(result);
      openTab(result.id);
      setCreating(false);
      setTitle('');
      setTask('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося створити сесію.');
    } finally {
      setBusy(false);
    }
  }

  async function connectCodex() {
    if (busy) return;
    setBusy(true);
    setCodexStatus({ state: 'connecting', message: 'З’єднання…', connectedAt: null });
    try {
      const connected = await requestJson<CodexConnectionStatus>('codex/connect', 'POST', {});
      setCodexStatus(connected);
      setError(null);
    } catch (reason) {
      setCodexStatus({ state: 'error', message: 'Підключення не вдалося.', connectedAt: null });
      setError(reason instanceof Error ? reason.message : 'Codex недоступний.');
    } finally {
      setBusy(false);
    }
  }

  async function bindCodexThread() {
    if (!active || busy) return;
    setBusy(true);
    try {
      const link = await requestJson<CodexSessionBinding>(
        `sessions/${active.id}/codex`,
        'POST',
        {},
      );
      const updated = await requestJson<AgentSession>(`sessions/${active.id}`);
      applySession(updated);
      setCodexStatus(link.connection);
      setCodexNotice(
        link.reused
          ? 'Існуючий thread підключено без запуску AI.'
          : active.codexThreadId
            ? 'Попередній порожній thread не мав історії Codex. Створено новий read-only thread.'
            : 'Створено новий read-only thread. Жодне AI-завдання не запущено.',
      );
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Codex thread недоступний.');
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(next: AgentSessionStatus) {
    if (!active || busy) return;
    setBusy(true);
    try {
      const result = await requestJson<AgentSession>(`sessions/${active.id}`, 'PATCH', {
        status: next,
      });
      applySession(result);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося змінити статус.');
    } finally {
      setBusy(false);
    }
  }

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!active || busy || !note.trim()) return;
    setBusy(true);
    try {
      const result = await requestJson<AgentSession>(`sessions/${active.id}/messages`, 'POST', {
        content: note,
      });
      applySession(result);
      setNote('');
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося зберегти нотатку.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app ws-app">
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="brand-mark">G</span>
          <span>
            <strong>Gym Dev Hub</strong>
            <small>Development workspace</small>
          </span>
        </Link>
        <div className="topbar-right">
          <span className="mode-dot" />
          <span>Локальні робочі сесії</span>
          <span className="topbar-badge">Worktree Plans / PR #9</span>
        </div>
      </header>

      <div className="ws-layout">
        <aside className="ws-sidebar">
          <div className="ws-sidebar-top">
            <Link href="/" className="ws-dashboard-link">
              ← GitHub Dashboard
            </Link>
            <div className="overline">AGENT WORKSPACE</div>
            <div className="ws-sidebar-heading">
              <strong>Робочі сесії</strong>
              <span>{sessions.length}</span>
            </div>
            <button
              type="button"
              className="ws-primary"
              onClick={() => setCreating((value) => !value)}
            >
              + Нова сесія
            </button>
          </div>
          <nav className="ws-session-nav" aria-label="Збережені сесії">
            {sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                className={`ws-session-link ${session.id === activeId ? 'is-active' : ''}`}
                onClick={() => openTab(session.id)}
              >
                <strong>{session.title}</strong>
                <small>
                  {session.repository.split('/')[1]} · {session.messageCount} нотаток
                </small>
                <span className={`ws-status ws-status-${session.status}`}>
                  {statusLabels[session.status]}
                </span>
              </button>
            ))}
            {sessions.length === 0 && (
              <p className="ws-empty-nav">Створи першу сесію, щоб почати роботу.</p>
            )}
          </nav>
          <div className="ws-sidebar-footer">
            <span>Дані зберігаються локально.</span>
            <span>Не додавай паролі або токени в нотатки.</span>
          </div>
        </aside>

        <main className="ws-main">
          <div className="ws-header">
            <div>
              <div className="overline">PARALLEL DEVELOPMENT</div>
              <h1>
                Agent Workspace<span className="accent">.</span>
              </h1>
              <p>Окремі задачі, вкладки й контекст для кожного майбутнього AI-агента.</p>
            </div>
            <button
              type="button"
              className="refresh"
              disabled={busy}
              onClick={() => void refresh()}
            >
              ↻ Оновити
            </button>
          </div>

          <BoundaryStatusPanel />
          <WorkerStatusPanel />

          <div className="ws-scope-notice ws-codex-panel">
            <div>
              <strong>
                Codex:{' '}
                {codexStatus.state === 'ready'
                  ? 'підключено'
                  : codexStatus.state === 'connecting'
                    ? 'підключення…'
                    : codexStatus.state === 'error'
                      ? 'помилка'
                      : 'вимкнено'}
                .
              </strong>
              <span>{codexStatus.message}</span>
              <small>
                Thread прив’язується до задачі без запуску AI-turn. Команди, Git і записи у файли
                залишаються вимкненими.
              </small>
            </div>
            <button
              className="ws-primary"
              type="button"
              disabled={busy || codexStatus.state === 'ready'}
              onClick={() => void connectCodex()}
            >
              {codexStatus.state === 'ready' ? 'Підключено' : 'Підключити Codex'}
            </button>
          </div>

          {error && (
            <div className="alert" role="alert">
              {error}
              <button type="button" className="ws-dismiss" onClick={() => setError(null)}>
                Закрити
              </button>
            </div>
          )}

          {creating && (
            <form className="ws-create-form" onSubmit={(event) => void createSession(event)}>
              <div className="ws-form-title">Нова робоча сесія</div>
              <label>
                Назва сесії
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  minLength={2}
                  maxLength={120}
                  required
                  placeholder="API · Auth improvements"
                />
              </label>
              <label>
                Репозиторій
                <select
                  required
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                >
                  {repositories.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Задача / acceptance criteria
                <textarea
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  minLength={3}
                  maxLength={1500}
                  required
                  rows={3}
                  placeholder="Один implementation slice → один PR → перевірка CI → ручний merge"
                />
              </label>
              <div className="ws-form-actions">
                <button
                  className="ws-primary"
                  disabled={busy || repositories.length === 0}
                  type="submit"
                >
                  {busy ? 'Зберігаємо…' : 'Створити сесію'}
                </button>
                <button type="button" onClick={() => setCreating(false)}>
                  Скасувати
                </button>
              </div>
            </form>
          )}

          <div className="ws-tabs" role="tablist" aria-label="Відкриті робочі сесії">
            {tabs.map((id) => {
              const tab = sessions.find((item) => item.id === id);
              if (!tab) return null;
              return (
                <div className={`ws-tab ${id === activeId ? 'is-active' : ''}`} key={id}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={id === activeId}
                    onClick={() => openTab(id)}
                  >
                    <span className="ws-tab-dot" />
                    {tab.title}
                  </button>
                  <button
                    type="button"
                    className="ws-tab-close"
                    onClick={() => closeTab(id)}
                    aria-label={`Закрити вкладку ${tab.title}`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>

          {!activeId && (
            <div className="ws-welcome">
              <div className="ws-welcome-icon">✦</div>
              <h2>Робоче місце для паралельної розробки</h2>
              <p>
                Створи сесію або відкрий збережену зліва. Кожна матиме власну задачу, статус та
                історію нотаток.
              </p>
              <button type="button" className="ws-primary" onClick={() => setCreating(true)}>
                + Додати сесію
              </button>
            </div>
          )}

          {activeId && !active && (
            <div className="ws-welcome">
              <p>Завантажуємо контекст сесії {activeSummary?.title ?? ''}…</p>
            </div>
          )}

          {active && (
            <div className="ws-detail" role="tabpanel">
              <div className="ws-detail-header">
                <div>
                  <div className="overline">SESSION · {active.repository}</div>
                  <h2>{active.title}</h2>
                  <span className="ws-date">Змінено {shortDate(active.updatedAt)}</span>
                  <div className="ws-codex-thread">
                    <div className="overline">CODEX THREAD · READ-ONLY</div>
                    {active.codexThreadId ? (
                      <code title={active.codexThreadId}>{active.codexThreadId}</code>
                    ) : (
                      <span>Thread ще не створено.</span>
                    )}
                    <button
                      type="button"
                      className="inspect-link"
                      disabled={busy || codexStatus.state !== 'ready'}
                      onClick={() => void bindCodexThread()}
                    >
                      {active.codexThreadId ? 'Підключити thread' : 'Прив’язати Codex thread'}
                    </button>
                    {codexNotice && <small role="status">{codexNotice}</small>}
                  </div>
                </div>
                <label className="ws-status-select">
                  Статус задачі
                  <select
                    disabled={busy}
                    value={active.status}
                    onChange={(event) =>
                      void changeStatus(event.target.value as AgentSessionStatus)
                    }
                  >
                    {(Object.keys(statusLabels) as AgentSessionStatus[]).map((status) => (
                      <option key={status} value={status}>
                        {statusLabels[status]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <section className="ws-task">
                <div className="overline">IMPLEMENTATION SLICE</div>
                <p>{active.task}</p>
                <div className="ws-task-meta">
                  Один PR · одна задача · ручний merge після review
                </div>
              </section>

              <WorktreePlanPanel
                key={active.id}
                sessionId={active.id}
                repository={active.repository}
                completed={active.status === 'completed'}
                onPrepareCodexDraft={(text) => setScopedDraft({ sessionId: active.id, text })}
              />

              <CodexChatPanel
                key={active.id}
                sessionId={active.id}
                enabled={codexStatus.state === 'ready' && Boolean(active.codexThreadId)}
                completed={active.status === 'completed'}
                draftToReview={scopedDraft?.sessionId === active.id ? scopedDraft.text : null}
              />

              <section className="ws-thread">
                <div className="ws-thread-head">
                  <h3>Історія сесії</h3>
                  <span>{active.messageCount} нотаток</span>
                </div>
                <div className="ws-thread-messages">
                  {active.messages.length === 0 && (
                    <div className="ws-thread-empty">
                      Тут зберігатиметься контекст роботи. Додай першу нотатку щодо задачі.
                    </div>
                  )}
                  {active.messages.map((message) => (
                    <article className="ws-message" key={message.id}>
                      <div className="ws-message-meta">
                        <strong>Твоя нотатка</strong>
                        <time dateTime={message.createdAt}>{shortDate(message.createdAt)}</time>
                      </div>
                      <p>{message.content}</p>
                    </article>
                  ))}
                </div>
                <form className="ws-compose" onSubmit={(event) => void addNote(event)}>
                  <label htmlFor="ws-note-input">Додати нотатку до сесії</label>
                  <textarea
                    id="ws-note-input"
                    rows={3}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Що зроблено, що перевірити, посилання на PR..."
                    maxLength={4000}
                    required
                  />
                  <div className="ws-compose-actions">
                    <span>Тільки локальне збереження · {note.length}/4000</span>
                    <button className="ws-primary" type="submit" disabled={busy || !note.trim()}>
                      {busy ? 'Зберігаємо…' : 'Зберегти нотатку'}
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
