import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorktreeIntegrityReport } from '@gym-dev-hub/contracts';
import { WorktreeToolPanel } from './worktree-tool-panel';

const report: WorktreeIntegrityReport = {
  planId: '00000000-0000-4000-8000-000000000123',
  sessionId: '00000000-0000-4000-8000-000000000456',
  status: 'verified',
  checkedAt: '2026-11-20T00:00:00.000Z',
  fileCount: 2,
  verifiedBytes: 80,
  findings: [],
  mount: {
    sourcePath: 'F:\\programer\\gym-dev-hub\\apps\\api\\.local\\worktrees\\test',
    targetPath: '/workspace',
    readOnly: true,
    networkEnabled: false,
    mountEnabled: false,
    executionEnabled: false,
  },
};

describe('independent worker tool consent', () => {
  it('requires manual SHA256_FILE approval and a separate operator secret', () => {
    const html = renderToStaticMarkup(
      <WorktreeToolPanel
        sessionId={report.sessionId}
        report={report}
        fingerprint={'sha256:' + 'a'.repeat(64)}
      />,
    );
    expect(html).toContain('Інструмент SHA-256 одного файла');
    expect(html).toContain('Авторизувати SHA-256');
    expect(html).toContain('DEV_HUB_WORKER_TOOL_SECRET');
    expect(html).toContain('type="password"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled');
    expect(html).not.toContain('Обчислити SHA-256 і видалити контейнер');
    expect(html).not.toContain('Запустити Codex');
  });
});
