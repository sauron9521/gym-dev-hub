'use client';

import { useState } from 'react';
import type {
  WorktreeCodeReadResult,
  WorktreePatchPreflightResult,
  WorktreePatchApplyGrant,
  WorktreePatchApplyResult,
  WorktreePostApplyReview,
} from '@gym-dev-hub/contracts';
import { MAX_PATCH_CHARS, reviewCodexPatch, type PatchReviewResult } from './codex-patch-review';
import { CodexPatchChecksPanel } from './codex-patch-checks-panel';

type Props = {
  source: WorktreeCodeReadResult;
  sourceCommit: string;
  fingerprint: string;
};

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function CodexPatchPreviewPanel({ source, sourceCommit, fingerprint }: Props) {
  const [patch, setPatch] = useState('');
  const [result, setResult] = useState<PatchReviewResult | null>(null);
  const [operatorSecret, setOperatorSecret] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [checking, setChecking] = useState(false);
  const [serverReport, setServerReport] = useState<WorktreePatchPreflightResult | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [writeSecret, setWriteSecret] = useState('');
  const [writeConfirmed, setWriteConfirmed] = useState(false);
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeGrant, setWriteGrant] = useState<WorktreePatchApplyGrant | null>(null);
  const [writeResult, setWriteResult] = useState<WorktreePatchApplyResult | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [postApplySecret, setPostApplySecret] = useState('');
  const [postApplyBusy, setPostApplyBusy] = useState(false);
  const [postApplyReport, setPostApplyReport] = useState<WorktreePostApplyReview | null>(null);
  const [postApplyError, setPostApplyError] = useState<string | null>(null);

  async function reviewAppliedChanges() {
    if (!writeResult || postApplyBusy || postApplySecret.length < 32) return;
    const secret = postApplySecret;
    setPostApplySecret('');
    setPostApplyBusy(true);
    setPostApplyError(null);
    setPostApplyReport(null);
    try {
      const response = await fetch(
        `/api/workspace/sessions/${source.sessionId}/worktree-plans/${source.planId}/patch-review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            grantId: writeResult.grantId,
            fingerprint,
            sourceCommit,
            filePath: writeResult.filePath,
            sourceSha256: writeResult.sourceSha256,
            proposedSha256: writeResult.proposedSha256,
            operatorSecret: secret,
          }),
        },
      );
      if (!response.ok)
        throw new Error(
          'Git review відхилено: перевір секрет, audit, Git або інші локальні зміни.',
        );
      const received = (await response.json()) as WorktreePostApplyReview;
      if (
        received.status !== 'verified' ||
        received.grantId !== writeResult.grantId ||
        received.filePath !== writeResult.filePath ||
        received.sourceCommit !== sourceCommit ||
        received.sourceSha256 !== writeResult.sourceSha256 ||
        received.proposedSha256 !== writeResult.proposedSha256 ||
        received.changedFiles !== 1 ||
        received.readOnly !== true ||
        received.testsExecuted !== false ||
        received.commitCreated !== false ||
        received.pushEnabled !== false ||
        received.mergeEnabled !== false
      ) {
        throw new Error('Небезпечний або невідповідний звіт Git review.');
      }
      setPostApplyReport(received);
    } catch (error) {
      setPostApplyError(error instanceof Error ? error.message : 'Помилка Git review.');
    } finally {
      setPostApplyBusy(false);
    }
  }

  async function authorizeOneFileWrite() {
    if (
      !result?.ok ||
      !serverReport ||
      !writeConfirmed ||
      writeSecret.length < 32 ||
      writeGrant ||
      writeBusy ||
      writeResult
    )
      return;
    const secret = writeSecret;
    setWriteSecret('');
    setWriteBusy(true);
    setWriteError(null);
    try {
      const response = await fetch(
        `/api/workspace/sessions/${source.sessionId}/worktree-plans/${source.planId}/patch-apply-authorize`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            fingerprint,
            sourceCommit,
            filePath: source.filePath,
            expectedSourceSha256: serverReport.sourceSha256,
            patch,
            operatorSecret: secret,
            confirmation: 'I_APPROVE_ONE_FILE_PATCH_ONLY',
          }),
        },
      );
      if (!response.ok)
        throw new Error('Одноразовий дозвіл не видано. Перевір opt-in, секрет і Git.');
      const received = (await response.json()) as WorktreePatchApplyGrant;
      if (
        received.purpose !== 'WRITE_ONE_APPROVED_WORKTREE_FILE' ||
        received.filePath !== source.filePath ||
        received.sourceCommit !== sourceCommit ||
        received.patchSha256 !== serverReport.patchSha256 ||
        received.proposedSha256 !== serverReport.proposedSha256
      ) {
        throw new Error('Недозволений або невідповідний grant.');
      }
      setWriteGrant(received);
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : 'Дозвіл не видано.');
    } finally {
      setWriteBusy(false);
    }
  }

  async function applyOnce() {
    if (!writeGrant || writeBusy || writeSecret.length < 32 || !serverReport || writeResult) return;
    const token = writeGrant.grantToken;
    const secret = writeSecret;
    setWriteSecret('');
    setWriteGrant(null); // Every attempted write permanently consumes the UI grant.
    setWriteBusy(true);
    setWriteError(null);
    try {
      const response = await fetch(
        `/api/workspace/sessions/${source.sessionId}/worktree-plans/${source.planId}/patch-apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            fingerprint,
            sourceCommit,
            filePath: source.filePath,
            expectedSourceSha256: serverReport.sourceSha256,
            patch,
            operatorSecret: secret,
            grantToken: token,
          }),
        },
      );
      if (!response.ok)
        throw new Error(
          'Патч не застосовано або стан невідомий. Перевір worktree та аудит вручну.',
        );
      const received = (await response.json()) as WorktreePatchApplyResult;
      if (
        received.status !== 'applied' ||
        received.filePath !== source.filePath ||
        received.sourceCommit !== sourceCommit ||
        received.proposedSha256 !== serverReport.proposedSha256 ||
        received.grantId !== writeGrant.grantId ||
        received.mergeEnabled !== false ||
        received.githubPushEnabled !== false
      ) {
        throw new Error('Результат запису потребує ручної перевірки.');
      }
      setWriteResult(received);
      setServerReport(null);
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : 'Перевір стан worktree вручну.');
      setServerReport(null); // A failed attempt may still have written data.
    } finally {
      setWriteBusy(false);
    }
  }

  async function verifyOnServer() {
    if (
      !result?.ok ||
      checking ||
      !acknowledged ||
      operatorSecret.length < 32 ||
      writeGrant ||
      writeResult
    )
      return;
    const secret = operatorSecret;
    setOperatorSecret('');
    setServerError(null);
    setServerReport(null);
    setChecking(true);
    try {
      const expectedSourceSha256 = await sha256(source.content);
      const response = await fetch(
        `/api/workspace/sessions/${source.sessionId}/worktree-plans/${source.planId}/patch-preflight`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            fingerprint,
            sourceCommit,
            filePath: source.filePath,
            expectedSourceSha256,
            patch,
            operatorSecret: secret,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          'Серверна перевірка відхилена: перевір локальні дозволи, Git worktree, SHA або патч.',
        );
      }
      const data = (await response.json()) as WorktreePatchPreflightResult;
      if (
        data.writeEnabled !== false ||
        data.authorizationGranted !== false ||
        data.readOnly !== true ||
        data.sourceCommit !== sourceCommit ||
        data.fingerprint !== fingerprint ||
        data.filePath !== source.filePath ||
        data.sourceSha256 !== expectedSourceSha256
      ) {
        throw new Error('Сервер повернув несподіваний або небезпечний результат.');
      }
      setServerReport(data);
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'Серверна перевірка недоступна.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="ws-worktree-authorization" aria-label="Перегляд AI патча">
      <div className="overline">CODEX PATCH PREVIEW · READ-ONLY</div>
      <h4>Перевірити запропонований AI-патч</h4>
      <p>
        Скопіюй unified diff з AI Chat. Перевіримо лише один уже прочитаний Git-файл і відповідність
        усіх старих рядків. Цей перегляд не записує файли та не запускає команди.
      </p>
      <label htmlFor="ws-patch-review-input">Unified diff для {source.filePath}</label>
      <textarea
        id="ws-patch-review-input"
        rows={7}
        value={patch}
        maxLength={MAX_PATCH_CHARS}
        spellCheck={false}
        placeholder={`--- a/${source.filePath}\n+++ b/${source.filePath}\n@@ -1 +1 @@\n-old\n+new`}
        disabled={checking || writeBusy || Boolean(writeGrant) || Boolean(writeResult)}
        onChange={(event) => {
          setPatch(event.target.value);
          setResult(null);
          setServerReport(null);
          setServerError(null);
          setAcknowledged(false);
          setWriteConfirmed(false);
          setWriteGrant(null);
          setWriteError(null);
        }}
      />
      <button
        type="button"
        className="refresh"
        disabled={
          !patch.trim() || checking || writeBusy || Boolean(writeGrant) || Boolean(writeResult)
        }
        onClick={() => {
          setResult(reviewCodexPatch(source, sourceCommit, patch));
          setServerReport(null);
          setServerError(null);
        }}
      >
        Перевірити і переглянути diff
      </button>
      {result && !result.ok && (
        <p role="alert" className="ws-chat-error">
          Патч відхилено: {result.error}
        </p>
      )}
      {result?.ok && (
        <div role="status" className="ws-worktree-inspection-result">
          <strong>Патч відповідає вибраному файлу та вихідним рядкам.</strong>
          <p>
            <code>{result.review.filePath}</code> · commit <code>{result.review.sourceCommit}</code>
          </p>
          <p>
            +{result.review.added} / −{result.review.removed} рядків · жодних змін на диску
          </p>
          <pre className="ws-code-read-result" aria-label="Перегляд diff">
            <code>
              {result.review.lines
                .map((line) => {
                  const sign =
                    line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' ';
                  const oldNo = line.oldLine === null ? '-' : String(line.oldLine);
                  const newNo = line.newLine === null ? '-' : String(line.newLine);
                  return `${oldNo.padStart(4)}  ${newNo.padStart(4)}  ${sign}${line.text}`;
                })
                .join('\n')}
            </code>
          </pre>
          <small>
            Це попередній локальний перегляд. Серверна перевірка повторно звірить актуальний
            worktree з Git, але не дозволить запис.
          </small>
          <label className="ws-plan-confirm">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={checking}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            Погоджую окрему read-only серверну перевірку саме цього файла, SHA та патча. Це не
            дозвіл редагувати код.
          </label>
          <label htmlFor="ws-patch-preflight-secret">Локальний секрет оператора</label>
          <input
            id="ws-patch-preflight-secret"
            type="password"
            autoComplete="off"
            value={operatorSecret}
            onChange={(event) => setOperatorSecret(event.target.value)}
            disabled={checking}
            placeholder="DEV_HUB_WORKTREE_OPERATOR_SECRET"
          />
          <button
            type="button"
            className="refresh"
            disabled={checking || !acknowledged || operatorSecret.length < 32}
            onClick={() => void verifyOnServer()}
          >
            {checking ? 'Повторно звіряємо Git…' : 'Перевірити актуальний worktree на сервері'}
          </button>
          {serverError && (
            <p role="alert" className="ws-chat-error">
              {serverError}
            </p>
          )}
          {serverReport && (
            <div role="status">
              <strong>Git та патч звірено, але право запису не надано.</strong>
              <p>
                Git: <code>{serverReport.sourceCommit}</code> · Перевірено:{' '}
                {new Date(serverReport.checkedAt).toLocaleString('uk-UA')}
              </p>
              <small>
                SHA-256 патча: <code>{serverReport.patchSha256}</code>
              </small>
              <small>
                SHA-256 запропонованого вмісту: <code>{serverReport.proposedSha256}</code>
              </small>
              <p>Режим: лише перевірка. Жодного файлу не змінено.</p>
              {!writeResult && !writeGrant && (
                <div className="ws-worktree-authorization">
                  <h4>Окремий дозвіл на зміну одного файла</h4>
                  <p>
                    Це вже реальний запис до ізольованого worktree. Створюється короткоживучий
                    одноразовий дозвіл на конкретний патч. Не змінює main, не робить commit чи PR.
                    Для скасування просто не погоджуй запис.
                  </p>
                  <label className="ws-plan-confirm">
                    <input
                      type="checkbox"
                      checked={writeConfirmed}
                      disabled={writeBusy}
                      onChange={(event) => setWriteConfirmed(event.target.checked)}
                    />
                    Я перевірив diff і явно дозволяю змінити один файл у цьому worktree.
                  </label>
                  <label htmlFor="ws-patch-write-secret">Окремий секрет застосування патча</label>
                  <input
                    id="ws-patch-write-secret"
                    type="password"
                    autoComplete="off"
                    value={writeSecret}
                    disabled={writeBusy}
                    onChange={(event) => setWriteSecret(event.target.value)}
                    placeholder="DEV_HUB_PATCH_APPLY_OPERATOR_SECRET"
                  />
                  <button
                    type="button"
                    className="refresh"
                    disabled={writeBusy || !writeConfirmed || writeSecret.length < 32}
                    onClick={() => void authorizeOneFileWrite()}
                  >
                    {writeBusy ? 'Перевірка дозволу…' : 'Видати одноразовий дозвіл на цей патч'}
                  </button>
                </div>
              )}
            </div>
          )}
          {writeGrant && !writeResult && (
            <div className="ws-worktree-authorization" role="status">
              <strong>
                Одноразовий дозвіл виданий до{' '}
                {new Date(writeGrant.expiresAt).toLocaleTimeString('uk-UA')}.
              </strong>
              <p>
                Увага: натискання наступної кнопки реально змінить файл у worktree. Відкат
                автоматично не виконується.
              </p>
              <label htmlFor="ws-patch-apply-again-secret">
                Повторно введи секрет для завершення
              </label>
              <input
                id="ws-patch-apply-again-secret"
                type="password"
                autoComplete="off"
                value={writeSecret}
                disabled={writeBusy}
                onChange={(event) => setWriteSecret(event.target.value)}
                placeholder="DEV_HUB_PATCH_APPLY_OPERATOR_SECRET"
              />
              <button
                type="button"
                className="ws-primary"
                disabled={writeBusy || writeSecret.length < 32}
                onClick={() => void applyOnce()}
              >
                {writeBusy ? 'Застосування…' : 'Застосувати один перевірений патч'}
              </button>
            </div>
          )}
          {writeError && (
            <p role="alert" className="ws-chat-error">
              {writeError}
            </p>
          )}
          {writeResult && (
            <div role="status">
              <strong>Файл змінено в ізольованому worktree.</strong>
              <p>
                SHA-256: <code>{writeResult.proposedSha256}</code>
              </p>
              <small>
                Злиття, push і commit не виконано. Перевір diff і тести перед створенням PR.
              </small>
              <div className="ws-worktree-authorization">
                <h4>Перевірити реальний Git diff після запису</h4>
                <p>
                  Сервер звірить audit, вихідний Git commit, усі файли worktree та рівно один
                  погоджений змінений файл. Тести не запускаються.
                </p>
                <label htmlFor="ws-patch-review-secret">
                  Секрет оператора для read-only review
                </label>
                <input
                  id="ws-patch-review-secret"
                  type="password"
                  autoComplete="off"
                  disabled={postApplyBusy}
                  value={postApplySecret}
                  onChange={(event) => setPostApplySecret(event.target.value)}
                  placeholder="DEV_HUB_PATCH_APPLY_OPERATOR_SECRET"
                />
                <button
                  type="button"
                  className="refresh"
                  disabled={postApplyBusy || postApplySecret.length < 32}
                  onClick={() => void reviewAppliedChanges()}
                >
                  {postApplyBusy ? 'Перевірка Git…' : 'Перевірити фактичні зміни та Git diff'}
                </button>
                {postApplyError && (
                  <p role="alert" className="ws-chat-error">
                    {postApplyError}
                  </p>
                )}
                {postApplyReport && (
                  <div role="status" className="ws-worktree-inspection-result">
                    <strong>Git review: перевірено рівно один змінений файл.</strong>
                    <p>
                      {postApplyReport.filePath} · {postApplyReport.changedFiles} змінений з{' '}
                      {postApplyReport.trackedFiles} файлів ·
                      {new Date(postApplyReport.checkedAt).toLocaleString('uk-UA')}
                    </p>
                    <pre className="ws-code-read-result" aria-label="Фактичний Git diff">
                      <code>{postApplyReport.diff}</code>
                    </pre>
                    <p>Рекомендовані наступні перевірки (ще не виконані):</p>
                    <ul>
                      {postApplyReport.recommendedChecks.map((check) => (
                        <li key={check}>
                          <code>{check}</code>
                        </li>
                      ))}
                    </ul>
                    <small>
                      Це read-only звіт про один момент часу. Перед PR ще потрібні тести, перевірка
                      diff, окремий commit/push та ручний merge.
                    </small>
                    <CodexPatchChecksPanel
                      key={writeResult.grantId}
                      sessionId={source.sessionId}
                      planId={source.planId}
                      fingerprint={fingerprint}
                      applied={writeResult}
                      verified={postApplyReport}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
