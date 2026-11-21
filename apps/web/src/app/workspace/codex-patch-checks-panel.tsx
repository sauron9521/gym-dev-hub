'use client';

import { useState } from 'react';
import type {
  WorktreePatchCheckGrant,
  WorktreePatchCheckRecipe,
  WorktreePatchCheckResult,
  WorktreePatchApplyResult,
  WorktreePostApplyReview,
} from '@gym-dev-hub/contracts';

type Props = {
  sessionId: string;
  planId: string;
  fingerprint: string;
  applied: WorktreePatchApplyResult;
  verified: WorktreePostApplyReview;
};

const checks = {
  API_TYPECHECK: 'API: TypeScript',
  API_TEST: 'API: Vitest',
  WEB_TYPECHECK: 'Web: TypeScript',
  WEB_TEST: 'Web: Vitest',
} as const;

export function CodexPatchChecksPanel({
  sessionId,
  planId,
  fingerprint,
  applied,
  verified,
}: Props) {
  const [recipeId, setRecipeId] = useState<WorktreePatchCheckRecipe>(
    applied.filePath.startsWith('apps/api/') ? 'API_TYPECHECK' : 'WEB_TYPECHECK',
  );
  const [reviewSecret, setReviewSecret] = useState('');
  const [checkSecret, setCheckSecret] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [grant, setGrant] = useState<WorktreePatchCheckGrant | null>(null);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [result, setResult] = useState<WorktreePatchCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allowed = applied.filePath.startsWith('apps/api/src/')
    ? (['API_TYPECHECK', 'API_TEST'] as const)
    : applied.filePath.startsWith('apps/web/src/')
      ? (['WEB_TYPECHECK', 'WEB_TEST'] as const)
      : [];

  const fields = {
    grantId: applied.grantId,
    fingerprint,
    sourceCommit: applied.sourceCommit,
    filePath: applied.filePath,
    sourceSha256: applied.sourceSha256,
    proposedSha256: applied.proposedSha256,
    recipeId,
  };
  const url = `/api/workspace/sessions/${sessionId}/worktree-plans/${planId}`;

  async function authorize() {
    if (
      !allowed.includes(recipeId as never) ||
      !acknowledged ||
      reviewSecret.length < 32 ||
      checkSecret.length < 32 ||
      busy ||
      grant ||
      result
    )
      return;
    const reviewOperatorSecret = reviewSecret;
    const operatorSecret = checkSecret;
    setReviewSecret('');
    setCheckSecret('');
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url + '/patch-check-authorize', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...fields,
          reviewOperatorSecret,
          operatorSecret,
          confirmation: 'I_APPROVE_ONE_FIXED_DOCKER_CHECK',
        }),
      });
      if (!response.ok)
        throw new Error('Docker check grant відхилений: перевір opt-in, секрети й Git.');
      const data = (await response.json()) as WorktreePatchCheckGrant;
      if (
        data.purpose !== 'AUTHORIZE_ONE_FIXED_POST_APPLY_DOCKER_CHECK' ||
        data.recipeId !== recipeId ||
        data.filePath !== applied.filePath ||
        data.proposedSha256 !== applied.proposedSha256 ||
        !data.grantToken
      ) {
        throw new Error('Повернуто невідповідний Docker check grant.');
      }
      setGrant(data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Помилка авторизації.');
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!grant || running || busy || reviewSecret.length < 32 || checkSecret.length < 32) return;
    const reviewOperatorSecret = reviewSecret;
    const operatorSecret = checkSecret;
    const token = grant.grantToken;
    const id = crypto.randomUUID();
    setReviewSecret('');
    setCheckSecret('');
    setGrant(null); // Grant consumed on every attempt, even when HTTP fails.
    setRunId(id);
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(url + '/patch-check-execute', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...fields,
          runId: id,
          grantToken: token,
          reviewOperatorSecret,
          operatorSecret,
        }),
      });
      if (!response.ok)
        throw new Error(
          'Перевірка не пройшла або стан невідомий. Новий grant потрібен після review.',
        );
      const report = (await response.json()) as WorktreePatchCheckResult;
      if (
        report.status !== 'passed' ||
        report.runId !== id ||
        report.grantId !== grant.grantId ||
        report.recipeId !== recipeId ||
        report.sourceCommit !== applied.sourceCommit ||
        report.proposedSha256 !== applied.proposedSha256 ||
        report.containerRemoved !== true ||
        report.readOnlySource !== true ||
        report.networkEnabled !== false ||
        report.arbitraryCommandsEnabled !== false ||
        report.commitCreated !== false ||
        report.pushEnabled !== false ||
        report.mergeEnabled !== false
      ) {
        throw new Error('Неприпустимий результат Docker check.');
      }
      setResult(report);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Docker check недоступний.');
    } finally {
      setRunning(false);
      setRunId(null);
    }
  }

  async function cancel() {
    if (!runId || checkSecret.length < 32) return;
    const operatorSecret = checkSecret;
    setCheckSecret('');
    try {
      const response = await fetch(url + '/patch-check-cancel', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, operatorSecret }),
      });
      if (!response.ok) throw new Error('Скасування не підтверджено.');
      setError('Скасування запрошено. Дочекайся завершення запиту й перевір очищення контейнера.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не вдалося підтвердити скасування.');
    }
  }

  if (
    !allowed.length ||
    verified.status !== 'verified' ||
    verified.grantId !== applied.grantId ||
    verified.proposedSha256 !== applied.proposedSha256
  ) {
    return null;
  }
  return (
    <section
      className="ws-worktree-authorization"
      aria-label="Ізольовані Docker checks після патча"
    >
      <div className="overline">POST-APPLY · FIXED DOCKER CHECKS</div>
      <h4>Окрема перевірка зміненого worktree</h4>
      <p>
        Після Git review можна явно запустити один фіксований TypeScript або Vitest рецепт у Docker
        без мережі. Це виконує код проєкту лише в ізольованому контейнері, але не створює commit,
        push чи PR. Секрет перевірки окремий від секрету запису.
      </p>
      <label htmlFor="ws-patch-check-recipe">Фіксований рецепт</label>
      <select
        id="ws-patch-check-recipe"
        value={recipeId}
        disabled={busy || running || Boolean(grant) || Boolean(result)}
        onChange={(event) => {
          setRecipeId(event.target.value as WorktreePatchCheckRecipe);
          setAcknownledgedFalse();
        }}
      >
        {allowed.map((id) => (
          <option value={id} key={id}>
            {checks[id]}
          </option>
        ))}
      </select>
      {!result && (
        <>
          <label className="ws-plan-confirm">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy || running || Boolean(grant)}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            Я перевірив Git diff і дозволяю лише цей рецепт для одного worktree.
          </label>
          <label htmlFor="ws-patch-check-review-secret">Секрет post-apply Git review</label>
          <input
            id="ws-patch-check-review-secret"
            type="password"
            autoComplete="off"
            value={reviewSecret}
            disabled={busy || running}
            onChange={(event) => setReviewSecret(event.target.value)}
          />
          <label htmlFor="ws-patch-check-secret">Окремий Docker check секрет</label>
          <input
            id="ws-patch-check-secret"
            type="password"
            autoComplete="off"
            value={checkSecret}
            disabled={busy}
            onChange={(event) => setCheckSecret(event.target.value)}
          />
          {!grant && !running && (
            <button
              type="button"
              className="refresh"
              disabled={
                busy || !acknowledged || reviewSecret.length < 32 || checkSecret.length < 32
              }
              onClick={() => void authorize()}
            >
              {busy ? 'Перевірка дозволу…' : 'Видати одноразовий дозвіл Docker check'}
            </button>
          )}
          {grant && !running && (
            <>
              <p>
                Дозвіл на один запуск до {new Date(grant.expiresAt).toLocaleTimeString('uk-UA')}.
                Для виконання введи обидва секрети ще раз.
              </p>
              <button
                type="button"
                className="refresh"
                disabled={reviewSecret.length < 32 || checkSecret.length < 32}
                onClick={() => void execute()}
              >
                Запустити {checks[grant.recipeId]} в Docker
              </button>
            </>
          )}
          {running && (
            <div role="status">
              <strong>Ізольована Docker-перевірка триває.</strong>
              <p>Щоб запросити скасування, введи Docker check секрет і натисни кнопку.</p>
              <button
                type="button"
                className="refresh"
                disabled={checkSecret.length < 32}
                onClick={() => void cancel()}
              >
                Скасувати Docker check
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="ws-chat-error">
          {error}
        </p>
      )}
      {result && (
        <div role="status">
          <strong>Docker check успішно пройшов. Контейнер прибрано.</strong>
          <p>
            {checks[result.recipeId]} · {Math.round(result.durationMs / 1000)} с
          </p>
          <small>
            Джерело read-only, мережа вимкнена; commit, push і merge не створювалися. Для запуску
            іншої перевірки потрібен новий дозвіл.
          </small>
        </div>
      )}
    </section>
  );

  function setAcknownledgedFalse() {
    setAcknowledged(false);
    setError(null);
  }
}
