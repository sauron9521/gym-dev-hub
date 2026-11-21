import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorktreeCommitWriteResult } from '@gym-dev-hub/contracts';
import { CodexGitHubPushPanel } from './codex-github-push-panel';

const committed: WorktreeCommitWriteResult = {
  runId: '00000000-0000-4000-8000-000000000987',
  grantId: '00000000-0000-4000-8000-000000000777',
  candidateSha256: 'c'.repeat(64),
  commitSha: 'd'.repeat(40),
  parentSha: 'e'.repeat(40),
  treeSha: 'f'.repeat(40),
  branch: 'devhub/task-' + 'a'.repeat(32),
  commitSubject: 'fix(api): approved one-file commit',
  filePathSha256: '1'.repeat(64),
  status: 'committed',
  worktreeClean: true,
  pushEnabled: false,
  mergeEnabled: false,
};

describe('new GitHub task branch publish UI', () => {
  it('initially permits only a disabled authorization step, no automatic publish', () => {
    const html = renderToStaticMarkup(
      <CodexGitHubPushPanel
        sessionId="00000000-0000-4000-8000-000000000456"
        planId="00000000-0000-4000-8000-000000000123"
        committed={committed}
      />,
    );
    expect(html).toContain('Опублікувати нову GitHub task-гілку');
    expect(html).toContain('Дозволити створення нової гілки');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('disabled');
    expect(html).toContain(committed.branch);
    expect(html).toContain('force-push');
    expect(html).not.toContain('Створити цю remote task-гілку');
    expect(html).not.toContain('Злити PR');
    expect(html).not.toContain('Merge');
    expect(html).not.toContain('github_pat_');
  });
});
