'use client';

import { useState } from 'react';
import { CodexGitHubPushPanel } from './codex-github-push-panel';
import type {
  WorktreeCommitCandidateAcknowledgement,
  WorktreeCommitWriteGrant,
  WorktreeCommitWriteResult,
} from '@gym-dev-hub/contracts';

type Props = {
  sessionId: string;
  planId: string;
  reviewed: WorktreeCommitCandidateAcknowledgement;
};

/**
 * No automatic execution on effect/mount, no retry, no stored operator
 * secrets. Each step is a distinct, explicit operator interaction.
 */
export function CodexCommitWritePanel({ sessionId, planId, reviewed }: Props) {
  const [candidateSecret, setCandidateSecret] = useState('');
  const [reviewSecret, setReviewSecret] = useState('');
  const [commitSecret, setCommitSecret] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [grant, setGrant] = useState<WorktreeCommitWriteGrant | null>(null);
  const [result, setResult] = useState<WorktreeCommitWriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/workspace/sessions/${sessionId}/worktree-plans/${planId}`;
  const secretsValid =
    candidateSecret.length >= 32 && reviewSecret.length >= 32 && commitSecret.length >= 32;

  function consumeSecrets() {
    const candidateOperatorSecret = candidateSecret;
    const reviewOperatorSecret = reviewSecret;
    const commitOperatorSecret = commitSecret;
    setCandidateSecret('');
    setReviewSecret('');
    setCommitSecret('');
    return { candidateOperatorSecret, reviewOperatorSecret, commitOperatorSecret };
  }

  async function authorize() {
    if (busy || grant || result || !confirmed || !secretsValid) return;
    const secrets = consumeSecrets();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url + '/commit-write-authorize', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId: reviewed.candidateId,
          candidateSha256: reviewed.candidateSha256,
          ...secrets,
          confirmation: 'I_AUTHORIZE_ONE_LOCAL_GIT_COMMIT_GRANT',
        }),
      });
      if (!response.ok)
        throw new Error(
          'Не вдалося видати одноразовий Git-дозвіл. Перевір налаштування, кандидата та SHA.',
        );
      const reply = (await response.json()) as WorktreeCommitWriteGrant;
      if (
        reply.purpose !== 'ONE_LOCAL_GIT_COMMIT_ONLY' ||
        reply.candidateId !== reviewed.candidateId ||
        reply.candidateSha256 !== reviewed.candidateSha256 ||
        reply.commitSubject !== reviewed.commitSubject ||
        reply.pushEnabled !== false ||
        reply.mergeEnabled !== false ||
        !reply.grantToken ||
        !reply.grantId
      ) {
        throw new Error('Сервер повернув неприпустимий Git grant.');
      }
      setGrant(reply);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Git-дозвіл недоступний.');
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (busy || !grant || result || !secretsValid || !confirmed) return;
    const secrets = consumeSecrets();
    const selected = grant;
    const runId = crypto.randomUUID();
    setGrant(null); // Any attempt burns this token. Never replay automatically.
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url + '/commit-write-execute', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grantId: selected.grantId,
          grantToken: selected.grantToken,
          runId,
          ...secrets,
          confirmation: 'I_EXECUTE_THIS_ONE_LOCAL_GIT_COMMIT_ONLY',
        }),
      });
      if (!response.ok)
        throw new Error(
          'Commit не підтверджено. Не повторюй запит: Git ref або index могли змінитися. Перевір стан вручну.',
        );
      const receipt = (await response.json()) as WorktreeCommitWriteResult;
      if (
        receipt.status !== 'committed' ||
        receipt.runId !== runId ||
        receipt.grantId !== selected.grantId ||
        receipt.candidateSha256 !== selected.candidateSha256 ||
        receipt.parentSha !== selected.sourceCommit ||
        receipt.commitSubject !== selected.commitSubject ||
        receipt.worktreeClean !== true ||
        receipt.pushEnabled !== false ||
        receipt.mergeEnabled !== false ||
        !receipt.commitSha ||
        !receipt.branch.startsWith('devhub/task-')
      ) {
        throw new Error('Git-операція має непідтверджений результат. Перевір стан вручну.');
      }
      setResult(receipt);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Результат Git commit невідомий.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-worktree-authorization" aria-label="Контрольований локальний Git commit">
      <div className="overline">LOCAL GIT COMMIT · OWNER ONLY · PR #68</div>
      <h4>Створити один локальний Git commit</h4>
      <p>
        Кандидат переглянуто, але commit ще не створено. Це окремий одноразовий дозвіл, обмежений
        одним схваленим файлом та гілкою devhub/task-*. Жодного GitHub push, PR або merge.
      </p>
      <p>
        Назва: <code>{reviewed.commitSubject}</code>
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
            Я дозволяю тільки один локальний Git commit у task-гілці. Я перевірив diff і розумію, що
            окремий push/merge не виконуватиметься.
          </label>
          <label htmlFor="ws-commit-write-review">Секрет Git review</label>
          <input
            id="ws-commit-write-review"
            type="password"
            autoComplete="off"
            value={reviewSecret}
            disabled={busy}
            onChange={(event) => setReviewSecret(event.target.value)}
          />
          <label htmlFor="ws-commit-write-candidate">Секрет commit candidate</label>
          <input
            id="ws-commit-write-candidate"
            type="password"
            autoComplete="off"
            value={candidateSecret}
            disabled={busy}
            onChange={(event) => setCandidateSecret(event.target.value)}
          />
          <label htmlFor="ws-commit-write-secret">Окремий секрет локального Git commit</label>
          <input
            id="ws-commit-write-secret"
            type="password"
            autoComplete="off"
            value={commitSecret}
            disabled={busy}
            onChange={(event) => setCommitSecret(event.target.value)}
          />
          {!grant && (
            <button
              type="button"
              className="refresh"
              disabled={busy || !confirmed || !secretsValid}
              onClick={() => void authorize()}
            >
              {busy ? 'Перевіряємо кандидата…' : 'Дозволити один Git commit'}
            </button>
          )}
          {grant && (
            <>
              <p>
                Одноразовий Git grant до {new Date(grant.expiresAt).toLocaleTimeString('uk-UA')}.
                Для виконання введи всі три секрети ще раз.
              </p>
              <button
                type="button"
                className="refresh"
                disabled={busy || !secretsValid}
                onClick={() => void execute()}
              >
                {busy ? 'Git commit виконується…' : 'Створити цей локальний commit'}
              </button>
            </>
          )}
        </>
      )}
      {result && (
        <div role="status">
          <strong>Локальний Git commit створено.</strong>
          <p>
            Commit: <code>{result.commitSha}</code>
          </p>
          <p>
            Branch: <code>{result.branch}</code>
          </p>
          <p>
            Parent: <code>{result.parentSha}</code>
          </p>
          <small>Worktree чистий. Push, PR і merge не виконувалися.</small>
          <CodexGitHubPushPanel sessionId={sessionId} planId={planId} committed={result} />
        </div>
      )}
      {error && (
        <p className="ws-chat-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
