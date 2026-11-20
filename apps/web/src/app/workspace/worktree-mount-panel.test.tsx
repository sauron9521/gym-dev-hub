import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorktreeIntegrityReport } from '@gym-dev-hub/contracts';
import { WorktreeMountPanel } from './worktree-mount-panel';

const report: WorktreeIntegrityReport = {
  sessionId: '00000000-0000-4000-8000-000000000456',
  planId: '00000000-0000-4000-8000-000000000123',
  checkedAt: '2026-11-20T00:00:00.000Z',
  status: 'verified', fileCount: 3, verifiedBytes: 100, findings: [],
  mount: {
    sourcePath: 'F:\\programer\\gym-dev-hub\\apps\\api\\.local\\worktrees\\test',
    targetPath: '/workspace', readOnly: true, networkEnabled: false,
    mountEnabled: false, executionEnabled: false,
  },
};

describe('ephemeral Docker mount consent panel', () => {
  it('requires explicit consent and operator secret before enabling a probe', () => {
    const html = renderToStaticMarkup(
      <WorktreeMountPanel
        sessionId={report.sessionId} report={report}
        fingerprint={'sha256:' + 'b'.repeat(64)}
      />,
    );
    expect(html).toContain('Тимчасовий read-only Docker mount');
    expect(html).toContain('type="password"');
    expect(html).toContain('Авторизувати тимчасовий mount');
    expect(html).toContain('disabled');
    expect(html).toContain('не дозвіл на виконання Codex');
    expect(html).not.toContain('Перевірити Docker mount та завершити контейнер');
    expect(html).not.toContain('Запустити Codex');
  });
});
