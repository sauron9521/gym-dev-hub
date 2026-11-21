import { describe, expect, it } from 'vitest';
import type { WorktreeCodeReadResult } from '@gym-dev-hub/contracts';
import { reviewCodexPatch } from './codex-patch-review';

const path = 'apps/api/src/main.ts';
const commit = 'a'.repeat(40);
const source: WorktreeCodeReadResult = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  planId: '00000000-0000-4000-8000-000000000002',
  filePath: path,
  content: 'one\ntwo\nthree\nfour\nfive\n',
  checkedAt: '2026-11-21T01:00:00.000Z',
  readOnly: true,
  networkEnabled: false,
  agentExecutionEnabled: false,
  containerRemoved: true,
};
const header = `--- a/${path}\n+++ b/${path}\n`;
const diff = (body: string) => header + body;
const reject = (body: string, current: WorktreeCodeReadResult = source) =>
  expect(reviewCodexPatch(current, commit, body).ok).toBe(false);

describe('client-side, single-file Codex diff review', () => {
  it('previews a standard one-file replacement with original and new line numbers', () => {
    const result = reviewCodexPatch(source, commit, diff('@@ -2 +2 @@\n-two\n+TWO'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.review.afterContent).toBe('one\nTWO\nthree\nfour\nfive\n');
    expect(result.review).toMatchObject({
      filePath: path,
      sourceCommit: commit,
      added: 1,
      removed: 1,
    });
    expect(result.review.lines).toEqual([
      { kind: 'deletion', oldLine: 2, newLine: null, text: 'two' },
      { kind: 'addition', oldLine: null, newLine: 2, text: 'TWO' },
    ]);
    // The pure function has no filesystem, network or Git access.
  });

  it('handles an optional exact git header, index line, context and multiple hunks', () => {
    const patch =
      `diff --git a/${path} b/${path}\nindex aaaaaaa..bbbbbbb 100644\n` +
      diff('@@ -1,2 +1,2 @@ first\n one\n-two\n+TWO\n@@ -4,2 +4,2 @@ last\n four\n-five\n+FIVE');
    const result = reviewCodexPatch(source, commit, patch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.review.afterContent).toBe('one\nTWO\nthree\nfour\nFIVE\n');
  });

  it('supports insertions at beginning/end and a deletion with zero-length ranges', () => {
    const atStart = reviewCodexPatch(source, commit, diff('@@ -0,0 +1 @@\n+zero'));
    expect(atStart.ok && atStart.review.afterContent.startsWith('zero\none\n')).toBe(true);
    const atEnd = reviewCodexPatch(source, commit, diff('@@ -5,0 +6 @@\n+six'));
    expect(atEnd.ok && atEnd.review.afterContent.endsWith('five\nsix\n')).toBe(true);
    const removal = reviewCodexPatch(source, commit, diff('@@ -2 +1,0 @@\n-two'));
    expect(removal.ok && removal.review.afterContent).toBe('one\nthree\nfour\nfive\n');
  });

  it('preserves meaningful trailing spaces in the final added line', () => {
    const result = reviewCodexPatch(source, commit, diff('@@ -2 +2 @@\n-two\n+TWO  '));
    expect(result.ok && result.review.afterContent).toContain('TWO  \n');
  });

  it('accepts a whole Markdown diff code fence, not surrounding arbitrary prose', () => {
    const patch = '```diff\n' + diff('@@ -2 +2 @@\n-two\n+TWO') + '\n```';
    expect(reviewCodexPatch(source, commit, patch).ok).toBe(true);
    reject('Please apply this diff\n' + diff('@@ -2 +2 @@\n-two\n+TWO'));
  });

  it('rejects the wrong file, additional files, rename, file creation and mode changes', () => {
    reject(diff('@@ -2 +2 @@\n-two\n+TWO').replaceAll(path, '../secrets.env'));
    reject(diff('@@ -2 +2 @@\n-two\n+TWO') + '\n--- a/another.ts\n+++ b/another.ts');
    reject(`diff --git a/${path} b/${path}\nrename from old\n` + diff('@@ -2 +2 @@\n-two\n+TWO'));
    reject(`--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x`);
    reject(
      `diff --git a/${path} b/${path}\nnew file mode 100644\n` + diff('@@ -2 +2 @@\n-two\n+TWO'),
    );
    reject(
      `diff --git a/${path} b/${path}\nindex aaa..bbb 120000\n` + diff('@@ -2 +2 @@\n-two\n+TWO'),
    );
  });

  it('rejects mismatching context, forged line ranges, overlapping hunks and malformed counts', () => {
    reject(diff('@@ -2 +2 @@\n-NOT TWO\n+TWO'));
    reject(diff('@@ -2 +1 @@\n-two\n+TWO'));
    reject(diff('@@ -2,2 +2,1 @@\n-two\n+TWO'));
    reject(diff('@@ -2 +2 @@\n-two\n+TWO\n@@ -2 +2 @@\n-two\n+again'));
    reject(diff('@@ -999 +999 @@\n-no\n+new'));
    reject(diff('@@ -0,0 +1,0 @@'));
    reject(diff('@@ -2 +2 @@\n two'));
  });

  it('rejects incomplete patches, no-newline markers, binary data and invalid line endings', () => {
    reject(diff('@@ -2 +2 @@\n-two'));
    reject(diff('@@ -2 +2 @@\n-two\n+TWO\n\\ No newline at end of file'));
    reject('GIT binary patch\n');
    reject(diff('@@ -2 +2 @@\r\n-two\r\n+TWO'));
    reject(diff('@@ -2 +2 @@\n-two\n+TWO\0'));
    reject(diff('@@ -2 +2 @@\n-two\n+TWO'), { ...source, content: 'one\ntwo' });
    reject(diff('@@ -2 +2 @@\n-two\n+TWO'), {
      ...source,
      content: source.content.replaceAll('\n', '\r\n'),
    });
  });

  it('rejects stale, unauthenticated and unsafe source records', () => {
    expect(reviewCodexPatch(source, 'not-a-sha', diff('@@ -2 +2 @@\n-two\n+TWO')).ok).toBe(false);
    for (const candidate of [
      { ...source, readOnly: false },
      { ...source, agentExecutionEnabled: true },
      { ...source, networkEnabled: true },
      { ...source, containerRemoved: false },
      { ...source, filePath: '../../private.env' },
    ]) {
      reject(diff('@@ -2 +2 @@\n-two\n+TWO'), candidate as WorktreeCodeReadResult);
    }
  });

  it('rejects excessive patch size, changed-line count, source size and output size', () => {
    reject('x'.repeat(20_001));
    reject(diff('@@ -2 +2,202 @@\n-two\n' + Array.from({ length: 202 }, () => '+line').join('\n')));
    reject(diff('@@ -2 +2 @@\n-two\n+TWO'), { ...source, content: 'x'.repeat(8200) + '\n' });
    reject(diff('@@ -2 +2 @@\n-two\n+' + 'x'.repeat(13_000)));
  });

  it('rejects all-zero change hunks and patches that net to identical content', () => {
    reject(diff('@@ -0,0 +0,0 @@'));
    reject(diff('@@ -2 +2 @@\n-two\n+two'));
  });
});
