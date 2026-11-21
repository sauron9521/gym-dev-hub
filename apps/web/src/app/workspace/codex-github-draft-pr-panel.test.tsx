import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorktreeGitHubPushResult } from '@gym-dev-hub/contracts';
import { CodexGitHubDraftPrPanel } from './codex-github-draft-pr-panel';

const published: WorktreeGitHubPushResult = {
  runId: '00000000-0000-4000-8000-000000000456',
  grantId: '00000000-0000-4000-8000-000000000777',
  branch: 'devhub/task-' + 'a'.repeat(32),
  commitSha: 'b'.repeat(40),
  parentSha: 'c'.repeat(40),
  branchUrl: 'https://github.com/sauron9521/gym-dev-hub/tree/devhub/task-' + 'a'.repeat(32),
  status: 'published',
  forcePushEnabled: false,
  mainWriteEnabled: false,
  pullRequestCreated: false,
  mergeEnabled: false,
};

describe('explicit GitHub Draft PR / read-only CI controls', () => {
  it('starts without any automatic draft creation or CI polling', () => {
    const html = renderToStaticMarkup(
      <CodexGitHubDraftPrPanel
        sessionId="00000000-0000-4000-8000-000000000456"
        planId="00000000-0000-4000-8000-000000000123"
        published={published}
      />,
    );
    expect(html).toContain('Створення Draft PR і перевірка CI');
    expect(html).toContain('Дозволити один Draft PR');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('disabled');
    expect(html).toContain(published.branch);
    expect(html).toContain('merge вимкнений');
    expect(html).not.toContain('Створити цей Draft PR');
    expect(html).not.toContain('Оновити CI');
    expect(html).not.toContain('Злити');
  });
});
