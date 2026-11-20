'use client';

import { useState } from 'react';
import type {
  TaskRunnerPreview,
  TaskRunnerRecipeId,
  WorktreeIntegrityReport,
} from '@gym-dev-hub/contracts';

type Props = { sessionId: string; report: WorktreeIntegrityReport; fingerprint: string };

const recipes: Array<{ value: TaskRunnerRecipeId; label: string }> = [
  { value: 'API_TEST', label: 'API — тести' },
  { value: 'API_TYPECHECK', label: 'API — TypeScript' },
  { value: 'API_LINT', label: 'API — lint' },
  { value: 'WEB_TEST', label: 'Web — тести' },
  { value: 'WEB_TYPECHECK', label: 'Web — TypeScript' },
  { value: 'WEB_LINT', label: 'Web — lint' },
];

export function TaskRunnerPreviewPanel({ sessionId, report, fingerprint }: Props) {
  const [recipeId, setRecipeId] = useState<TaskRunnerRecipeId>('API_TEST');
  const [preview, setPreview] = useState<TaskRunnerPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function inspectRecipe() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const response = await fetch(
        `/api/workspace/sessions/${sessionId}/worktree-plans/${report.planId}/task-preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipeId, fingerprint }),
          cache: 'no-store',
        },
      );
      if (!response.ok) {
        throw new Error('Не вдалося сформувати план. Перевір Git worktree та його цілісність.');
      }
      setPreview((await response.json()) as TaskRunnerPreview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'План недоступний.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-worktree-authorization" aria-label="Попередній перегляд тестового runner">
      <div className="overline">TASK RUNNER POLICY · PR #19</div>
      <h4>План перевірок Gym Platform</h4>
      <p>
        Можна перевірити точну майбутню команду, Git commit і пропоновані обмеження. Це не запускає
        тести, Docker або Codex і не видає дозволу на виконання.
      </p>
      <label htmlFor="task-runner-recipe">Дозволений рецепт</label>
      <select
        id="task-runner-recipe"
        value={recipeId}
        disabled={busy}
        onChange={(event) => {
          setRecipeId(event.target.value as TaskRunnerRecipeId);
          setPreview(null);
          setError(null);
        }}
      >
        {recipes.map((recipe) => (
          <option key={recipe.value} value={recipe.value}>
            {recipe.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="refresh"
        disabled={busy}
        onClick={() => void inspectRecipe()}
      >
        {busy ? 'Перевіряємо…' : 'Переглянути команду й обмеження'}
      </button>
      {preview && (
        <div className="ws-worktree-inspection-result" role="status">
          <strong>{preview.label}</strong>
          <p>Статус: тільки перегляд. Виконання вимкнено; окремий дозвіл не видано.</p>
          <div className="ws-plan-detail">
            <div>
              <span>Git commit</span>
              <code>{preview.baseHeadSha}</code>
            </div>
            <div>
              <span>Пакетна команда (argv)</span>
              <code>{JSON.stringify(preview.argv)}</code>
            </div>
            <div>
              <span>Пропонована мережа</span>
              <strong>{preview.proposedBoundary.network}</strong>
            </div>
            <div>
              <span>Майбутня ізоляція</span>
              <strong>read-only source + tmpfs</strong>
            </div>
          </div>
          <ul>
            {preview.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="ws-chat-error">
          {error}
        </p>
      )}
      <small>
        Запуск реальних pnpm-скриптів виконує код репозиторію. Потрібні окремий Docker runner,
        обмеження ресурсів, захист секретів і дозвіл оператора в наступних PR.
      </small>
    </div>
  );
}
