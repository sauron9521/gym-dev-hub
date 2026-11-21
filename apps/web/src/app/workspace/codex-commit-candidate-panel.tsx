'use client';

import { useState } from 'react';
import type {
  WorktreePatchApplyResult,
  WorktreePostApplyReview,
  WorktreeCommitCandidatePreview,
  WorktreeCommitCandidateAcknowledgement,
} from '@gym-dev-hub/contracts';

type Props = {
  sessionId: string;
  planId: string;
  fingerprint: string;
  applied: WorktreePatchApplyResult;
  verified: WorktreePostApplyReview;
};
const SUBJECT =
  /^(feat|fix|refactor|docs|test|chore|perf|build|ci|style)(\([a-z][a-z0-9-]{0,29}\))?: [\p{L}\p{N}][^\r\n]*$/u;
const labels = {
  API_TYPECHECK: 'API TypeScript',
  API_TEST: 'API Vitest',
  WEB_TYPECHECK: 'Web TypeScript',
  WEB_TEST: 'Web Vitest',
} as const;

export function CodexCommitCandidatePanel({
  sessionId,
  planId,
  fingerprint,
  applied,
  verified,
}: Props) {
  const [subject, setSubject] = useState('');
  const [reviewSecret, setReviewSecret] = useState('');
  const [candidateSecret, setCandidateSecret] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [preview, setPreview] = useState<WorktreeCommitCandidatePreview | null>(null);
  const [receipt, setReceipt] = useState<WorktreeCommitCandidateAcknowledgement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scope =
    applied.filePath.startsWith('apps/api/src/') || applied.filePath.startsWith('apps/web/src/');
  if (
    !scope ||
    verified.status !== 'verified' ||
    verified.grantId !== applied.grantId ||
    verified.proposedSha256 !== applied.proposedSha256
  ) {
    return null;
  }

  const url = `/api/workspace/sessions/${sessionId}/worktree-plans/${planId}`;
  const fields = {
    grantId: applied.grantId,
    fingerprint,
    sourceCommit: applied.sourceCommit,
    filePath: applied.filePath,
    sourceSha256: applied.sourceSha256,
    proposedSha256: applied.proposedSha256,
    commitSubject: subject,
  };
  const validSubject =
    subject.length >= 10 &&
    subject.length <= 72 &&
    subject === subject.trim() &&
    SUBJECT.test(subject);

  async function requestPreview() {
    if (
      busy ||
      preview ||
      receipt ||
      !validSubject ||
      reviewSecret.length < 32 ||
      candidateSecret.length < 32
    )
      return;
    const reviewOperatorSecret = reviewSecret;
    const operatorSecret = candidateSecret;
    setReviewSecret('');
    setCandidateSecret('');
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url + '/commit-candidate-preview', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields, reviewOperatorSecret, operatorSecret }),
      });
      if (!response.ok) {
        throw new Error(
          'Кандидат не підтверджено Git: потрібна щонайменше одна успішна Docker-перевірка, актуальний diff і локальні дозволи.',
        );
      }
      const data = (await response.json()) as WorktreeCommitCandidatePreview;
      if (
        data.status !== 'review-required' ||
        data.readOnly !== true ||
        data.commitCreated !== false ||
        data.stagingEnabled !== false ||
        data.pushEnabled !== false ||
        data.mergeEnabled !== false ||
        data.sessionId !== sessionId ||
        data.planId !== planId ||
        data.commitSubject !== subject ||
        data.sourceCommit !== applied.sourceCommit ||
        data.filePath !== applied.filePath ||
        data.proposedSha256 !== applied.proposedSha256 ||
        !Array.isArray(data.verifiedRecipes) ||
        !data.verifiedRecipes.length ||
        !Array.isArray(data.missingRecipes) ||
        !data.candidateId ||
        !data.candidateSha256
      ) {
        throw new Error('Неприпустима відповідь попереднього перегляду.');
      }
      setPreview(data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Помилка preview.');
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge() {
    if (
      !preview ||
      receipt ||
      busy ||
      !acknowledged ||
      reviewSecret.length < 32 ||
      candidateSecret.length < 32
    )
      return;
    const reviewOperatorSecret = reviewSecret;
    const operatorSecret = candidateSecret;
    const snapshot = preview;
    setPreview(null); // one-time snapshot consumed even on network/server failure
    setReviewSecret('');
    setCandidateSecret('');
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url + '/commit-candidate-acknowledge', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...fields,
          candidateId: snapshot.candidateId,
          candidateSha256: snapshot.candidateSha256,
          confirmation: 'I_REVIEWED_THIS_COMMIT_CANDIDATE_ONLY',
          reviewOperatorSecret,
          operatorSecret,
        }),
      });
      if (!response.ok)
        throw new Error('Кандидат змінився або підтвердження відхилено. Зроби новий preview.');
      const data = (await response.json()) as WorktreeCommitCandidateAcknowledgement;
      if (
        data.status !== 'operator-reviewed' ||
        data.candidateId !== snapshot.candidateId ||
        data.candidateSha256 !== snapshot.candidateSha256 ||
        data.commitSubject !== snapshot.commitSubject ||
        data.previewOnly !== true ||
        data.commitCreated !== false ||
        data.stagingEnabled !== false ||
        data.pushEnabled !== false ||
        data.mergeEnabled !== false
      ) {
        throw new Error('Невідповідне підтвердження кандидата.');
      }
      setReceipt(data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Підтвердження недоступне.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="ws-worktree-authorization"
      aria-label="Попередній перегляд кандидата Git commit"
    >
      <div className="overline">COMMIT CANDIDATE · READ ONLY · PR #67</div>
      <h4>Кандидат на Git commit</h4>
      <p>
        Після успішної Docker-перевірки сервер звірить фактичний Git diff, підпише його SHA-256 та
        перевірить незмінність файла. Це лише підготовка для ручного огляду. Немає git add, commit,
        push чи merge.
      </p>
      {!receipt && (
        <>
          <label htmlFor="ws-commit-subject">Назва майбутнього коміту (Conventional Commits)</label>
          <input
            id="ws-commit-subject"
            type="text"
            maxLength={72}
            placeholder="fix(api): describe the reviewed change"
            value={subject}
            disabled={busy || Boolean(preview)}
            onChange={(event) => {
              setSubject(event.target.value);
              setAcknowledged(false);
              setError(null);
            }}
          />
          <small>
            Один рядок, не більше 72 символів, наприклад fix(api): clarify the validation.
          </small>
          <label htmlFor="ws-commit-review-secret">Секрет Post-Apply Git Review</label>
          <input
            id="ws-commit-review-secret"
            type="password"
            autoComplete="off"
            value={reviewSecret}
            disabled={busy}
            onChange={(event) => setReviewSecret(event.target.value)}
          />
          <label htmlFor="ws-commit-operator-secret">Незалежний секрет Commit Candidate</label>
          <input
            id="ws-commit-operator-secret"
            type="password"
            autoComplete="off"
            value={candidateSecret}
            disabled={busy}
            onChange={(event) => setCandidateSecret(event.target.value)}
          />
          {!preview && (
            <button
              className="refresh"
              type="button"
              onClick={() => void requestPreview()}
              disabled={
                busy || !validSubject || reviewSecret.length < 32 || candidateSecret.length < 32
              }
            >
              {busy ? 'Перевіряємо Git…' : 'Підготувати read-only кандидат'}
            </button>
          )}
        </>
      )}
      {preview && !receipt && (
        <div role="status">
          <strong>Кандидат сформовано. Git commit не створений.</strong>
          <p>
            Назва: <code>{preview.commitSubject}</code>
          </p>
          <p>
            Файл: <code>{preview.filePath}</code>
          </p>
          <p>
            HEAD: <code>{preview.sourceCommit}</code>
          </p>
          <small>
            SHA-256 diff: <code>{preview.diffSha256}</code>
          </small>
          <small>
            SHA-256 кандидата: <code>{preview.candidateSha256}</code>
          </small>
          <p>
            Пройшли: {preview.verifiedRecipes.map((recipe) => labels[recipe]).join(', ')}.
            {preview.missingRecipes.length > 0 &&
              ` Не перевірено: ${preview.missingRecipes.map((recipe) => labels[recipe]).join(', ')}.`}
          </p>
          <pre className="ws-code-read-result" aria-label="Перевірений diff для майбутнього коміту">
            <code>{preview.diff}</code>
          </pre>
          <small>
            Кандидат чинний до {new Date(preview.expiresAt).toLocaleTimeString('uk-UA')}.
          </small>
          <label className="ws-plan-confirm">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            Я перевірив назву, актуальний Git diff і список тестів. Розумію, що це лише
            підтвердження перегляду, а не дозвіл створювати Git commit.
          </label>
          <button
            type="button"
            className="refresh"
            disabled={
              busy || !acknowledged || reviewSecret.length < 32 || candidateSecret.length < 32
            }
            onClick={() => void acknowledge()}
          >
            {busy ? 'Повторна перевірка…' : 'Підтвердити перегляд саме цього кандидата'}
          </button>
        </div>
      )}
      {receipt && (
        <div role="status">
          <strong>Кандидат переглянуто й підтверджено оператором.</strong>
          <p>
            <code>{receipt.commitSubject}</code>
          </p>
          <small>Підтверджено: {new Date(receipt.acknowledgedAt).toLocaleString('uk-UA')}</small>
          <p>Жодного файла не додано до Git index. Commit, push і merge не виконані.</p>
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
