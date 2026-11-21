'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { ChatSnapshot, ChatStreamEvent } from '@gym-dev-hub/contracts';

interface Props {
  sessionId: string;
  enabled: boolean;
  completed: boolean;
  draftToReview?: string | null;
}

async function getChat(sessionId: string): Promise<ChatSnapshot> {
  const response = await fetch(`/api/workspace/sessions/${sessionId}/chat`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Не вдалося завантажити історію Codex.');
  return (await response.json()) as ChatSnapshot;
}

export function CodexChatPanel({ sessionId, enabled, completed, draftToReview }: Props) {
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = snapshot?.turn.state === 'starting' || snapshot?.turn.state === 'streaming';

  useEffect(() => {
    let cancelled = false;
    const url = `/api/workspace/sessions/${sessionId}/chat/events`;
    const refresh = () => {
      void getChat(sessionId)
        .then((data) => {
          if (!cancelled) setSnapshot(data);
        })
        .catch((reason: unknown) => {
          if (!cancelled)
            setError(reason instanceof Error ? reason.message : 'Chat API недоступний.');
        });
    };
    refresh();

    const stream = new EventSource(url);
    stream.onopen = () => {
      if (!cancelled) setConnected(true);
    };
    stream.onmessage = (event: MessageEvent<string>) => {
      if (cancelled) return;
      try {
        const packet = JSON.parse(event.data) as ChatStreamEvent;
        if (packet.kind === 'snapshot' && packet.snapshot) {
          setSnapshot(packet.snapshot);
        } else if (packet.kind === 'progress' && packet.turn) {
          setSnapshot((old) => (old ? { ...old, turn: packet.turn! } : old));
        } else if (packet.kind === 'refresh') {
          refresh();
        }
      } catch {
        setError('Отримано некоректну подію Codex.');
      }
    };
    stream.onerror = () => {
      if (!cancelled) setConnected(false);
    };
    // Fallback for EventSource outages; prevents a stuck "generating" UI.
    const fallback = setInterval(() => {
      if (stream.readyState !== EventSource.OPEN) refresh();
    }, 2000);
    return () => {
      cancelled = true;
      stream.close();
      clearInterval(fallback);
    };
  }, [sessionId]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || completed || sending || running || !prompt.trim()) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspace/sessions/${sessionId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: prompt.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message ?? 'Codex не прийняв повідомлення.');
      }
      const value = (await response.json()) as ChatSnapshot;
      setPrompt('');
      setSnapshot((old) =>
        old && old.turn.state === 'streaming' ? { ...value, turn: old.turn } : value,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Помилка надсилання.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="ws-chat-panel" aria-label="Codex AI чат">
      <div className="ws-chat-heading">
        <div>
          <div className="overline">CODEX AI · READ-ONLY</div>
          <h3>AI Chat</h3>
        </div>
        <span className={`ws-chat-live ${connected ? 'is-live' : ''}`}>
          {connected ? 'Live stream' : 'Відновлення потоку'}
        </span>
      </div>
      <div className="ws-chat-disclaimer">
        Чат підключений до локального Codex, але не має дозволу змінювати код. Запити можуть
        передаватися сервісу OpenAI. Не надсилай секрети, паролі або токени.
      </div>
      <div className="ws-chat-messages" aria-live="polite">
        {!snapshot && <div className="ws-thread-empty">Завантаження історії чату…</div>}
        {snapshot && snapshot.messages.length === 0 && !running && (
          <div className="ws-thread-empty">
            Повідомлень ще немає. Напиши запит — Codex відповість у цьому вікні.
          </div>
        )}
        {snapshot?.messages.map((entry) => (
          <div className={`ws-chat-bubble ws-chat-${entry.role}`} key={entry.id}>
            <div className="ws-message-meta">
              <strong>{entry.role === 'user' ? 'Ти' : 'Codex'}</strong>
              <time dateTime={entry.createdAt}>
                {entry.createdAt.slice(0, 16).replace('T', ' ')}
              </time>
            </div>
            <p>
              {entry.content || (entry.state === 'failed' ? 'Відповідь не вдалася.' : 'Перервано.')}
            </p>
            {entry.state !== 'completed' && <span className="ws-chat-error">{entry.state}</span>}
          </div>
        ))}
        {running && (
          <div className="ws-chat-bubble ws-chat-assistant">
            <div className="ws-message-meta">
              <strong>Codex · відповідає…</strong>
            </div>
            <p>{snapshot?.turn.draft || 'Генеруємо відповідь…'}</p>
          </div>
        )}
      </div>
      {error && (
        <p className="ws-chat-error" role="alert">
          {error}
        </p>
      )}
      {draftToReview && (
        <div className="ws-chat-disclaimer" role="status">
          Пропозиція з перевіреного Git-файла готова. Перенесення в поле вводу не надсилає її до
          Codex.
          <button
            type="button"
            className="refresh"
            disabled={completed || sending || running || Boolean(prompt)}
            onClick={() => setPrompt(draftToReview)}
          >
            Вставити чернетку в чат
          </button>
          {prompt && (
            <small>Спочатку очисти поточну чернетку, щоб не втратити введений текст.</small>
          )}
        </div>
      )}
      <form className="ws-compose ws-chat-compose" onSubmit={(event) => void send(event)}>
        <label htmlFor="ws-codex-input">Повідомлення до Codex</label>
        <textarea
          id="ws-codex-input"
          rows={3}
          maxLength={3000}
          placeholder={
            enabled
              ? 'Опиши задачу або постав запитання…'
              : 'Спочатку підключи Codex та прив’яжи thread.'
          }
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={!enabled || completed || sending || running}
        />
        <div className="ws-compose-actions">
          <span>Текстовий режим · {prompt.length}/3000</span>
          <button
            type="submit"
            className="ws-primary"
            disabled={!enabled || completed || sending || running || !prompt.trim()}
          >
            {running ? 'Codex відповідає…' : sending ? 'Надсилання…' : 'Надіслати до Codex'}
          </button>
        </div>
        {completed && <small>Завершена сесія доступна лише для читання.</small>}
      </form>
    </section>
  );
}
