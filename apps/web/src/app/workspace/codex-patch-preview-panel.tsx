'use client';

import { useState } from 'react';
import type { WorktreeCodeReadResult } from '@gym-dev-hub/contracts';
import { MAX_PATCH_CHARS, reviewCodexPatch, type PatchReviewResult } from './codex-patch-review';

type Props = {
  source: WorktreeCodeReadResult;
  sourceCommit: string;
};

export function CodexPatchPreviewPanel({ source, sourceCommit }: Props) {
  const [patch, setPatch] = useState('');
  const [result, setResult] = useState<PatchReviewResult | null>(null);

  return (
    <section className="ws-worktree-authorization" aria-label="Перегляд AI патча">
      <div className="overline">CODEX PATCH PREVIEW · READ-ONLY</div>
      <h4>Перевірити запропонований AI-патч</h4>
      <p>
        Скопіюй unified diff з AI Chat. Перевіримо лише один уже прочитаний Git-файл і відповідність
        усіх старих рядків. Це локальний перегляд у браузері: жодних запитів до API, запису файлів
        або запуску команд.
      </p>
      <label htmlFor="ws-patch-review-input">Unified diff для {source.filePath}</label>
      <textarea
        id="ws-patch-review-input"
        rows={7}
        value={patch}
        maxLength={MAX_PATCH_CHARS}
        spellCheck={false}
        placeholder={`--- a/${source.filePath}\n+++ b/${source.filePath}\n@@ -1 +1 @@\n-old\n+new`}
        onChange={(event) => {
          setPatch(event.target.value);
          setResult(null);
        }}
      />
      <button
        type="button"
        className="refresh"
        disabled={!patch.trim()}
        onClick={() => setResult(reviewCodexPatch(source, sourceCommit, patch))}
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
            Перевірка стосується лише тексту зі збереженого результату читання. Це не повторна
            перевірка поточного стану worktree і не дозвіл застосовувати патч. Перед записом
            потрібні нова перевірка Git, окремий дозвіл та review.
          </small>
        </div>
      )}
    </section>
  );
}
