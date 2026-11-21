import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorktreePatchApplyResult, WorktreePostApplyReview } from '@gym-dev-hub/contracts';
import { CodexCommitCandidatePanel } from './codex-commit-candidate-panel';

const applied: WorktreePatchApplyResult = {
  sessionId: '00000000-0000-4000-8000-000000000456',
  planId: '00000000-0000-4000-8000-000000000123',
  grantId: '00000000-0000-4000-8000-000000000777',
  filePath: 'apps/api/src/main.ts',
  sourceCommit: 'a'.repeat(40),
  sourceSha256: 'b'.repeat(64),
  proposedSha256: 'c'.repeat(64),
  appliedAt: '2026-11-21T07:00:00.000Z',
  status: 'applied',
  githubPushEnabled: false,
  mergeEnabled: false,
};
const verified: WorktreePostApplyReview = {
  sessionId: applied.sessionId,
  planId: applied.planId,
  grantId: applied.grantId,
  filePath: applied.filePath,
  sourceCommit: applied.sourceCommit,
  sourceSha256: applied.sourceSha256,
  proposedSha256: applied.proposedSha256,
  checkedAt: '2026-11-21T07:01:00.000Z',
  status: 'verified',
  changedFiles: 1,
  trackedFiles: 100,
  diff: 'diff --git a/apps/api/src/main.ts b/apps/api/src/main.ts\n@@ -1 +1 @@',
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
  fingerprint: 'sha256:' + 'd'.repeat(64),
  applied,
  verified,
};

describe('explicit read-only Git commit candidate UI', () => {
  it('offers only a disabled preview until subject and two secrets are entered', () => {
    const html = renderToStaticMarkup(<CodexCommitCandidatePanel {...props} />);
    expect(html).toContain('Попередній перегляд кандидата Git commit');
    expect(html).toContain('Кандидат на Git commit');
    expect(html).toContain('Conventional Commits');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('Підготувати read-only кандидат');
    expect(html).toContain('disabled');
    expect(html).not.toContain('I_APPROVE_GIT_COMMIT');
    expect(html).not.toContain('Створити Git commit');
    expect(html).not.toContain('Виконати push');
  });

  it('refuses mismatched post-apply Git snapshots and out-of-scope files', () => {
    const mismatch = renderToStaticMarkup(
      <CodexCommitCandidatePanel
        {...props}
        verified={{ ...verified, proposedSha256: 'f'.repeat(64) }}
      />,
    );
    expect(mismatch).toBe('');
    const docs = renderToStaticMarkup(
      <CodexCommitCandidatePanel
        {...props}
        applied={{ ...applied, filePath: 'README.md' }}
        verified={{ ...verified, filePath: 'README.md' }}
      />,
    );
    expect(docs).toBe('');
  });
});
