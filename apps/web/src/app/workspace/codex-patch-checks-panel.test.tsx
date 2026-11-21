import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorktreePatchApplyResult, WorktreePostApplyReview } from '@gym-dev-hub/contracts';
import { CodexPatchChecksPanel } from './codex-patch-checks-panel';

const applied: WorktreePatchApplyResult = {
  sessionId: '00000000-0000-4000-8000-000000000456',
  planId: '00000000-0000-4000-8000-000000000123',
  grantId: '00000000-0000-4000-8000-000000000777',
  filePath: 'apps/api/src/main.ts',
  sourceCommit: 'a'.repeat(40),
  sourceSha256: 'c'.repeat(64),
  proposedSha256: 'd'.repeat(64),
  appliedAt: '2026-11-21T02:00:00.000Z',
  status: 'applied',
  mergeEnabled: false,
  githubPushEnabled: false,
};

const verified: WorktreePostApplyReview = {
  sessionId: applied.sessionId,
  planId: applied.planId,
  grantId: applied.grantId,
  filePath: applied.filePath,
  sourceCommit: applied.sourceCommit,
  sourceSha256: applied.sourceSha256,
  proposedSha256: applied.proposedSha256,
  checkedAt: '2026-11-21T02:01:00.000Z',
  status: 'verified',
  changedFiles: 1,
  trackedFiles: 2,
  diff: '--- a/apps/api/src/main.ts\n+++ b/apps/api/src/main.ts',
  recommendedChecks: [],
  readOnly: true,
  testsExecuted: false,
  commitCreated: false,
  pushEnabled: false,
  mergeEnabled: false,
};

const props = {
  sessionId: applied.sessionId,
  planId: applied.planId,
  fingerprint: 'sha256:' + 'b'.repeat(64),
  applied,
  verified,
};

describe('post-apply fixed Docker checks panel', () => {
  it('shows only API recipes for an approved API source file, no execution by default', () => {
    const html = renderToStaticMarkup(<CodexPatchChecksPanel {...props} />);
    expect(html).toContain('Ізольовані Docker checks після патча');
    expect(html).toContain('API: TypeScript');
    expect(html).toContain('API: Vitest');
    expect(html).not.toContain('Web: Vitest');
    expect(html).not.toContain('Web: TypeScript');
    expect(html).toContain('disabled');
    expect(html).toContain('Видати одноразовий дозвіл Docker check');
    expect(html).not.toContain('Запустити API: TypeScript в Docker');
    expect(html).not.toContain('Застосувати патч');
  });

  it('hides Docker execution controls for non-source changes and mismatched receipts', () => {
    const docsChange = renderToStaticMarkup(
      <CodexPatchChecksPanel {...props} applied={{ ...applied, filePath: 'README.md' }} />,
    );
    expect(docsChange).toBe('');
    const mismatch = renderToStaticMarkup(
      <CodexPatchChecksPanel
        {...props}
        verified={{ ...verified, proposedSha256: 'e'.repeat(64) }}
      />,
    );
    expect(mismatch).toBe('');
  });

  it('shows only Web recipes for a verified Web source change', () => {
    const filePath = 'apps/web/src/app/page.tsx';
    const html = renderToStaticMarkup(
      <CodexPatchChecksPanel
        {...props}
        applied={{ ...applied, filePath }}
        verified={{ ...verified, filePath }}
      />,
    );
    expect(html).toContain('Web: TypeScript');
    expect(html).toContain('Web: Vitest');
    expect(html).not.toContain('API: Vitest');
  });
});
