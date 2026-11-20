import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorktreeIntegrityReport } from '@gym-dev-hub/contracts';
import { WorktreeCodeReadPanel } from './worktree-code-read-panel';

const report: WorktreeIntegrityReport = {
  sessionId: '00000000-0000-4000-8000-000000000456',
  planId: '00000000-0000-4000-8000-000000000123',
  checkedAt: new Date().toISOString(),
  status: 'verified',
  fileCount: 3,
  verifiedBytes: 100,
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

describe('one-file read-only Docker consent panel', () => {
  it('is disabled until file, separate confirmation and secret are provided', () => {
    const html = renderToStaticMarkup(
      <WorktreeCodeReadPanel sessionId={report.sessionId} report={report} fingerprint={'sha256:' + 'b'.repeat(64)} />,
    );
    expect(html).toContain('Прочитати один файл у Docker');
    expect(html).toContain('type="password"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled');
    expect(html).toContain('Авторизувати читання одного файла');
    expect(html).toContain('не дозвіл запускати');
    expect(html).not.toContain('Прочитати та видалити контейнер');
    expect(html).not.toContain('Запустити Codex');
  });
});
