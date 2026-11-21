'use client';

import { useState } from 'react';
import type {
  PullReadiness,
  WorktreeDraftPrGrant,
  WorktreeDraftPrResult,
  WorktreeGitHubPushResult,
} from '@gym-dev-hub/contracts';

type Props = {
  sessionId: string;
  planId: string;
  published: WorktreeGitHubPushResult;
};

const ciLabels = {
  success: 'Пройшли',
  failure: 'Помилка',
  pending: 'Виконуються',
  unknown: 'Немає підтвердження',
} as const;

/** Explicit two-step Draft PR creation and manual read-only CI refresh. */
export function CodexGitHubDraftPrPanel({ sessionId, planId, published }: Props) {
  const [secret, setSecret] = useState('');
  const [approved, setApproved] = useState(false);
  const [grant, setGrant] = useState<WorktreeDraftPrGrant | null>(null);
  const [created, setCreated] = useState<WorktreeDraftPrResult | null>(null);
  const [checks, setChecks] = useState<PullReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/workspace/sessions/${sessionId}/worktree-plans/${planId}`;
  const enabled = approved && !busy && secret.length >= 32;

  async function authorize() {
    if (!enabled || grant || created) return;
    const operatorSecret = secret;
    setSecret('');
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint + '/github-draft-pr-authorize', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitSha: published.commitSha,
          operatorSecret,
          confirmation: 'I_AUTHORIZE_CREATE_ONE_DRAFT_PR_ONLY',
        }),
      });
      if (!response.ok)
        throw new Error(
          'Дозвіл Draft PR відхилено. Перевір GitHub-токен, SHA, попередні PR та локальний аудит.',
        );
      const data = (await response.json()) as WorktreeDraftPrGrant;
      if (
        data.purpose !== 'CREATE_ONE_GITHUB_DRAFT_PR_ONLY' ||
        data.branch !== published.branch ||
        data.commitSha !== published.commitSha ||
        data.baseBranch !== 'main' ||
        data.draft !== true ||
        data.branchWriteEnabled !== false ||
        data.mergeEnabled !== false ||
        !data.grantToken ||
        !data.grantId
      ) {
        throw new Error('Неприпустимий дозвіл на Draft PR.');
      }
      setGrant(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не вдалося отримати дозвіл.');
    } finally {
      setBusy(false);
    }
  }

  async function createDraft() {
    if (!enabled || !grant || created) return;
    const operatorSecret = secret;
    const snapshot = grant;
    const runId = crypto.randomUUID();
    setSecret('');
    setGrant(null); // One-shot on any outcome. No retry after ambiguous POST.
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint + '/github-draft-pr-execute', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grantId: snapshot.grantId,
          grantToken: snapshot.grantToken,
          runId,
          operatorSecret,
          confirmation: 'I_CREATE_THIS_EXACT_GITHUB_DRAFT_PR',
        }),
      });
      if (!response.ok)
        throw new Error(
          'Draft PR не підтверджено. Не повторюй запит: перевір GitHub і локальний lock.',
        );
      const data = (await response.json()) as WorktreeDraftPrResult;
      if (
        data.status !== 'draft-created' ||
        data.draft !== true ||
        data.grantId !== snapshot.grantId ||
        data.runId !== runId ||
        data.branch !== snapshot.branch ||
        data.commitSha !== snapshot.commitSha ||
        data.title !== snapshot.title ||
        data.baseBranch !== 'main' ||
        data.branchWriteEnabled !== false ||
        data.mergeEnabled !== false ||
        !Number.isSafeInteger(data.number) ||
        data.number < 1 ||
        !data.url.startsWith('https://github.com/sauron9521/gym-dev-hub/pull/')
      ) {
        throw new Error('Непідтверджений результат створення GitHub Draft PR.');
      }
      setCreated(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Результат Draft PR невідомий.');
    } finally {
      setBusy(false);
    }
  }

  async function refreshCI() {
    if (!created || busy) return;
    setChecks(null);
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(endpoint + '/github-draft-pr-ci', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prNumber: created.number,
          commitSha: created.commitSha,
        }),
      });
      if (!response.ok) throw new Error('Не вдалося перевірити CI для цього Draft PR.');
      const data = (await response.json()) as PullReadiness;
      if (
        data.number !== created.number ||
        data.headSha !== created.commitSha ||
        data.baseBranch !== 'main' ||
        !data.draft ||
        !Array.isArray(data.checks)
      ) {
        throw new Error('Отримано CI іншого Pull Request.');
      }
      setChecks(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Статус CI невідомий.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-worktree-authorization" aria-label="Створення Draft PR і перевірка CI">
      <div className="overline">DRAFT PULL REQUEST · MANUAL · PR #70</div>
      <h4>Створити Draft Pull Request</h4>
      <p>
        З опублікованої task-гілки <code>{published.branch}</code> із commit{' '}
        <code>{published.commitSha.slice(0, 12)}</code> у <code>main</code>. Дублікати заборонені.
        Створюється тільки Draft; merge вимкнений.
      </p>
      {!created && (
        <>
          <label className="ws-plan-confirm">
            <input
              type="checkbox"
              checked={approved}
              disabled={busy || Boolean(grant)}
              onChange={(event) => setApproved(event.target.checked)}
            />
            Підтверджую створення лише одного Draft PR з перевіреної гілки. Розумію, що CI й review
            ще потрібні, merge не виконується.
          </label>
          <label htmlFor="ws-draft-pr-secret">Незалежний секрет Draft PR</label>
          <input
            id="ws-draft-pr-secret"
            type="password"
            autoComplete="off"
            value={secret}
            disabled={busy}
            onChange={(event) => setSecret(event.target.value)}
          />
          {!grant ? (
            <button
              type="button"
              className="refresh"
              disabled={!enabled}
              onClick={() => void authorize()}
            >
              {busy ? 'Перевірка GitHub…' : 'Дозволити один Draft PR'}
            </button>
          ) : (
            <>
              <p>
                Заголовок PR: <code>{grant.title}</code>
              </p>
              <p>
                Дозвіл чинний до {new Date(grant.expiresAt).toLocaleTimeString('uk-UA')}. Для
                виконання введи секрет повторно.
              </p>
              <button
                type="button"
                className="refresh"
                disabled={!enabled}
                onClick={() => void createDraft()}
              >
                {busy ? 'Створюємо Draft PR…' : 'Створити цей Draft PR'}
              </button>
            </>
          )}
        </>
      )}
      {created && (
        <div role="status">
          <strong>Draft PR #{created.number} створено.</strong>
          <p>
            <code>{created.title}</code>
          </p>
          <p>
            HEAD: <code>{created.commitSha}</code>
          </p>
          <p>
            <a href={created.url} target="_blank" rel="noopener noreferrer">
              Відкрити Draft PR на GitHub
            </a>
          </p>
          <p>
            <a href={`/pr/${created.number}?repository=sauron9521%2Fgym-dev-hub`}>
              Повна перевірка PR та required CI у Hub
            </a>
          </p>
          <button
            type="button"
            className="refresh"
            disabled={busy}
            onClick={() => void refreshCI()}
          >
            {busy ? 'Завантаження CI…' : checks ? 'Оновити CI' : 'Перевірити CI'}
          </button>
          {checks && (
            <div role="status">
              <p>
                Поточні перевірки: <strong>{ciLabels[checks.checksState]}</strong>. Required checks:{' '}
                <strong>{ciLabels[checks.requiredState]}</strong>.
              </p>
              <p>
                Оцінка готовності: <strong>{checks.verdict}</strong>.
              </p>
              {checks.checks.length === 0 && (
                <p>Немає підтверджених checks. Не вважай це успіхом.</p>
              )}
              {checks.checks.map((check) => (
                <p key={check.name + ':' + check.appId}>
                  <code>{check.name}</code> — {ciLabels[check.state]}
                </p>
              ))}
              {checks.unavailable.length > 0 && (
                <small>Частина даних GitHub недоступна. Не вважай CI завершеним.</small>
              )}
              <small>Статус read-only; merge потребує окремої ручної дії в GitHub.</small>
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="ws-chat-error">
          {error}
        </p>
      )}
    </section>
  );
}
