import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorktreeIntegrityReport } from '@gym-dev-hub/contracts';
import { TaskRunnerPreviewPanel } from './task-runner-preview-panel';

const report: WorktreeIntegrityReport = {
  sessionId: '00000000-0000-4000-8000-000000000456',
  planId: '00000000-0000-4000-8000-000000000123',
  status: 'verified',
  checkedAt: '2026-11-20T10:00:00.000Z',
  fileCount: 10,
  verifiedBytes: 1000,
  findings: [],
  mount: {
    sourcePath: '/safe/worktree',
    targetPath: '/workspace',
    readOnly: true,
    networkEnabled: false,
    mountEnabled: false,
    executionEnabled: false,
  },
};

describe('task runner review-only panel', () => {
  it('shows the six fixed recipes but no launch or approval controls', () => {
    const html = renderToStaticMarkup(
      <TaskRunnerPreviewPanel
        sessionId={report.sessionId}
        report={report}
        fingerprint={'sha256:' + 'b'.repeat(64)}
      />,
    );
    for (const id of [
      'API_TEST',
      'API_TYPECHECK',
      'API_LINT',
      'WEB_TEST',
      'WEB_TYPECHECK',
      'WEB_LINT',
    ]) {
      expect(html).toContain(id);
    }
    expect(html).toContain('Переглянути команду й обмеження');
    expect(html).toContain('Це не запускає тести');
    expect(html).not.toContain('Запустити тест');
    expect(html).not.toContain('Злити PR');
  });
});
