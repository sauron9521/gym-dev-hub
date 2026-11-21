'use client';

import { useState } from 'react';
import type { WorktreeCodeReadResult, WorktreePatchPreflightResult } from '@gym-dev-hub/contracts';
import { MAX_PATCH_CHARS, reviewCodexPatch, type PatchReviewResult } from './codex-patch-review';

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

  async function verifyOnServer() {
    if (!result?.ok || checking || !acknowledged || operatorSecret.length < 32) return;
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
        disabled={checking}
        onChange={(event) => {
          setPatch(event.target.value);
          setResult(null);
          setServerReport(null);
          setServerError(null);
          setAcknowledged(false);
        }}
      />
      <button
        type="button"
        className="refresh"
        disabled={!patch.trim() || checking}
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
            </div>
          )}
        </div>
      )}
    </section>
  );
}
