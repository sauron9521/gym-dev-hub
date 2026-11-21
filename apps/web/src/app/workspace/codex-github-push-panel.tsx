'use client';

import { useState } from 'react';
import { CodexGitHubDraftPrPanel } from './codex-github-draft-pr-panel';
import type {
  WorktreeCommitWriteResult,
  WorktreeGitHubPushGrant,
  WorktreeGitHubPushResult,
} from '@gym-dev-hub/contracts';

type Props = { sessionId: string; planId: string; committed: WorktreeCommitWriteResult };

/** Manual two-step publish: no automatically triggered fetch or token reuse. */
export function CodexGitHubPushPanel({ sessionId, planId, committed }: Props) {
  const [operatorSecret, setOperatorSecret] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [grant, setGrant] = useState<WorktreeGitHubPushGrant | null>(null);
  const [result, setResult] = useState<WorktreeGitHubPushResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/workspace/sessions/${sessionId}/worktree-plans/${planId}`;
  const ready = !busy && confirmed && operatorSecret.length >= 32;

  async function authorize() {
    if (!ready || grant || result) return;
    const secret = operatorSecret;
    setOperatorSecret('');
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint + '/github-push-authorize', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitSha: committed.commitSha,
          operatorSecret: secret,
          confirmation: 'I_AUTHORIZE_NEW_TASK_BRANCH_ONLY',
        }),
      });
      if (!response.ok)
        throw new Error(
          'Дозвіл не видано: перевір Git commit, remote branch, локальний audit і секрет.',
        );
      const value = (await response.json()) as WorktreeGitHubPushGrant;
      if (
        value.commitSha !== committed.commitSha ||
        value.parentSha !== committed.parentSha ||
        value.branch !== committed.branch ||
        value.purpose !== 'CREATE_NEW_GITHUB_TASK_BRANCH_ONLY' ||
        value.forcePushEnabled !== false ||
        value.mainWriteEnabled !== false ||
        value.pullRequestEnabled !== false ||
        value.mergeEnabled !== false ||
        !value.grantId ||
        !value.grantToken
      ) {
        throw new Error('Недостовірний GitHub publish grant.');
      }
      setGrant(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Дозвіл GitHub недоступний.');
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!ready || !grant || result) return;
    const secret = operatorSecret;
    const current = grant;
    const runId = crypto.randomUUID();
    setGrant(null); // Burn one-use capability in UI before the network call.
    setOperatorSecret('');
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint + '/github-push-execute', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId,
          grantId: current.grantId,
          grantToken: current.grantToken,
          operatorSecret: secret,
          confirmation: 'I_PUBLISH_THIS_EXACT_COMMIT_TO_NEW_TASK_BRANCH',
        }),
      });
      if (!response.ok)
        throw new Error(
          'Результат GitHub publish невідомий. Не повторюй дію. Перевір remote branch та локальний lock.',
        );
      const receipt = (await response.json()) as WorktreeGitHubPushResult;
      if (
        receipt.runId !== runId ||
        receipt.grantId !== current.grantId ||
        receipt.commitSha !== current.commitSha ||
        receipt.parentSha !== current.parentSha ||
        receipt.branch !== current.branch ||
        receipt.status !== 'published' ||
        receipt.forcePushEnabled !== false ||
        receipt.mainWriteEnabled !== false ||
        receipt.pullRequestCreated !== false ||
        receipt.mergeEnabled !== false
      ) {
        throw new Error('GitHub publish не підтверджено. Перевір гілку вручну.');
      }
      setResult(receipt);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Підтвердження публікації відсутнє.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-worktree-authorization" aria-label="Опублікувати нову GitHub task-гілку">
      <div className="overline">GITHUB TASK BRANCH · MANUAL · PR #69</div>
      <h4>Опублікувати нову task-гілку</h4>
      <p>
        Лише одна нова гілка <code>{committed.branch}</code> з уже перевіреним commit{' '}
        <code>{committed.commitSha.slice(0, 12)}</code>. Існуючі remote-гілки, main, force-push,
        створення PR та merge недоступні.
      </p>
      {!result && (
        <>
          <label className="ws-plan-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || Boolean(grant)}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Я погоджую створити тільки цю нову GitHub task-гілку з перевіреним SHA. Це не створює PR
            і не виконує merge.
          </label>
          <label htmlFor="ws-github-push-secret">Незалежний секрет GitHub publish</label>
          <input
            id="ws-github-push-secret"
            type="password"
            autoComplete="off"
            value={operatorSecret}
            disabled={busy}
            onChange={(event) => setOperatorSecret(event.target.value)}
          />
          {!grant ? (
            <button
              type="button"
              className="refresh"
              disabled={!ready}
              onClick={() => void authorize()}
            >
              {busy ? 'Перевірка GitHub…' : 'Дозволити створення нової гілки'}
            </button>
          ) : (
            <>
              <p>
                Одноразовий дозвіл до {new Date(grant.expiresAt).toLocaleTimeString('uk-UA')}. Введи
                секрет повторно та окремо підтвердь публікацію.
              </p>
              <button
                type="button"
                className="refresh"
                disabled={!ready}
                onClick={() => void publish()}
              >
                {busy ? 'Публікація GitHub…' : 'Створити цю remote task-гілку'}
              </button>
            </>
          )}
        </>
      )}
      {result && (
        <div role="status">
          <strong>Гілку опубліковано на GitHub.</strong>
          <p>
            Branch: <code>{result.branch}</code>
          </p>
          <p>
            Commit SHA: <code>{result.commitSha}</code>
          </p>
          <a href={result.branchUrl} target="_blank" rel="noopener noreferrer">
            Перейти до task-гілки на GitHub
          </a>
          <small>Жодного force-push, змін main, PR або merge.</small>
          <CodexGitHubDraftPrPanel sessionId={sessionId} planId={planId} published={result} />
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
