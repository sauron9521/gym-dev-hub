import type { WorktreeCodeReadResult } from './worktree.js';

export const MAX_PATCH_CHARS = 20_000;
const MAX_SOURCE_BYTES = 8_192;
const MAX_OUTPUT_BYTES = 12_288;
const MAX_HUNKS = 20;
const MAX_CHANGED_LINES = 200;
const SHA = /^[0-9a-f]{40,64}$/;

type Kind = 'context' | 'addition' | 'deletion';

export interface PatchReviewLine {
  kind: Kind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface PatchReview {
  filePath: string;
  sourceCommit: string;
  added: number;
  removed: number;
  lines: PatchReviewLine[];
  afterContent: string;
}

export type PatchReviewResult = { ok: true; review: PatchReview } | { ok: false; error: string };

function denied(error: string): PatchReviewResult {
  return { ok: false, error };
}

function boundedNumber(value: string): number {
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < 0 || num > 10_000) {
    throw new Error('Недопустимі номери рядків або розмір діапазону.');
  }
  return num;
}

/**
 * Pure, in-memory review of a *single* unified diff against one approved
 * Docker-read Git blob. No patch execution, disk writes, API calls or Git.
 * Deliberately excludes binary/rename/mode/new/delete/no-newline patches.
 */
export function reviewCodexPatch(
  source: WorktreeCodeReadResult,
  sourceCommit: string,
  rawPatch: string,
): PatchReviewResult {
  if (
    !source.readOnly ||
    source.agentExecutionEnabled ||
    source.networkEnabled ||
    !source.containerRemoved ||
    !SHA.test(sourceCommit)
  ) {
    return denied('Немає підтвердженого read-only Git snapshot.');
  }
  const path = source.filePath;
  if (
    path.length < 1 ||
    path.length > 160 ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\\\r\n\0]/.test(path)
  ) {
    return denied('Недозволений шлях до вихідного файла.');
  }
  if (
    typeof rawPatch !== 'string' ||
    !rawPatch ||
    rawPatch.length > MAX_PATCH_CHARS ||
    /[\r\0]/.test(rawPatch)
  ) {
    return denied('Порожній, надто великий або некоректний патч.');
  }
  if (
    !source.content.endsWith('\n') ||
    source.content.includes('\r') ||
    new TextEncoder().encode(source.content).length > MAX_SOURCE_BYTES
  ) {
    return denied('Цей preview підтримує лише невеликі LF-файли з фінальним newline.');
  }

  try {
    let patch = rawPatch;
    // Strip only the outer formatting lines, never meaningful spaces in diff records.
    if (patch.startsWith('```diff\n') && (patch.endsWith('\n```') || patch.endsWith('\n```\n'))) {
      if (patch.endsWith('\n')) patch = patch.slice(0, -1);
      patch = patch.slice(8, -4);
    } else if (patch.endsWith('\n')) {
      patch = patch.slice(0, -1);
    }
    const records = patch.split('\n');
    let position = 0;
    if (records[position]?.startsWith('diff --git ')) {
      if (records[position] !== `diff --git a/${path} b/${path}`) {
        return denied('Git diff вказує на інший або декілька файлів.');
      }
      position++;
    }
    if (records[position]?.startsWith('index ')) {
      if (
        !/^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}(?: 100(?:644|755))?$/.test(records[position]!)
      ) {
        return denied('Git metadata патча мають недозволений формат.');
      }
      position++;
    }
    if (records[position++] !== `--- a/${path}` || records[position++] !== `+++ b/${path}`) {
      return denied('Патч має змінювати рівно той файл, який прочитано з Git.');
    }
    if (!records[position]?.startsWith('@@ ')) {
      return denied('У unified diff не знайдено жодного hunk.');
    }

    const before = source.content.slice(0, -1).split('\n');
    const after: string[] = [];
    const lines: PatchReviewLine[] = [];
    let sourceIndex = 0;
    let hunks = 0;
    let added = 0;
    let removed = 0;

    while (position < records.length) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(
        records[position++]!,
      );
      if (!header || ++hunks > MAX_HUNKS) {
        return denied('Некоректний hunk або перевищено ліміт 20 блоків.');
      }
      const oldStart = boundedNumber(header[1]!);
      const oldCount = boundedNumber(header[2] ?? '1');
      const newStart = boundedNumber(header[3]!);
      const newCount = boundedNumber(header[4] ?? '1');
      if (!oldCount && !newCount) return denied('Порожній hunk заборонено.');

      // Zero-length old ranges are insertions *after* oldStart.
      const targetIndex = oldCount === 0 ? oldStart : oldStart - 1;
      if (
        targetIndex < sourceIndex ||
        targetIndex > before.length ||
        oldStart > before.length + 1
      ) {
        return denied('Hunk виходить за межі файла або перетинає попередній.');
      }
      after.push(...before.slice(sourceIndex, targetIndex));
      sourceIndex = targetIndex;
      const expectedNewStart = after.length + (newCount > 0 ? 1 : 0);
      if (newStart !== expectedNewStart) {
        return denied('Номери нових рядків не відповідають попереднім змінам.');
      }

      let consumed = 0;
      let produced = 0;
      let changedInHunk = false;
      while (position < records.length && !records[position]!.startsWith('@@ ')) {
        const record = records[position++]!;
        const prefix = record[0];
        const value = record.slice(1);
        if (![' ', '+', '-'].includes(prefix) || record.length < 1) {
          return denied('Патч містить непідтримувані metadata або зміну іншого файла.');
        }
        if (prefix === ' ' || prefix === '-') {
          if (sourceIndex >= before.length || before[sourceIndex] !== value) {
            return denied('Вихідні рядки патча не збігаються з перевіреним Git-файлом.');
          }
          const oldLine = sourceIndex + 1;
          sourceIndex++;
          consumed++;
          if (prefix === ' ') {
            after.push(value);
            produced++;
            lines.push({ kind: 'context', oldLine, newLine: after.length, text: value });
          } else {
            removed++;
            changedInHunk = true;
            lines.push({ kind: 'deletion', oldLine, newLine: null, text: value });
          }
        } else {
          after.push(value);
          added++;
          produced++;
          changedInHunk = true;
          lines.push({ kind: 'addition', oldLine: null, newLine: after.length, text: value });
        }
        if (consumed > oldCount || produced > newCount || added + removed > MAX_CHANGED_LINES) {
          return denied('Кількість рядків не відповідає hunk або перевищує ліміт 200 змін.');
        }
      }
      if (!changedInHunk || consumed !== oldCount || produced !== newCount) {
        return denied('Некоректні лічильники рядків у hunk.');
      }
    }
    after.push(...before.slice(sourceIndex));
    const afterContent = after.join('\n') + '\n';
    if (new TextEncoder().encode(afterContent).length > MAX_OUTPUT_BYTES) {
      return denied('Результат патча перевищує ліміт 12 КіБ.');
    }
    if (afterContent === source.content) return denied('Патч не змінює вміст файла.');
    return {
      ok: true,
      review: { filePath: path, sourceCommit, added, removed, lines, afterContent },
    };
  } catch {
    return denied('Неприпустимий або неповний unified diff.');
  }
}
