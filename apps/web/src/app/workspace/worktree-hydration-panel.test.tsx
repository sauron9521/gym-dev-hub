import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorktreePlan } from '@gym-dev-hub/contracts';
import { WorktreeHydrationPanel } from './worktree-hydration-panel';

const base: WorktreePlan = {
  id: '00000000-0000-4000-8000-000000000123',
  sessionId: '00000000-0000-4000-8000-000000000456',
  repository: 'sauron9521/gym-platform',
  sourcePath: 'F:\\programer\\gym-platform',
  targetPath: 'F:\\programer\\gym-dev-hub\\apps\\api\\.local\\worktrees\\test',
  proposedBranch: 'devhub/task-00000000000040008000000000000123',
  fingerprint: 'sha256:' + 'a'.repeat(64),
  state: 'created',
  createdAt: '2026-11-20T00:00:00.000Z',
  expiresAt: null,
  history: [],
  baseHeadSha: 'b'.repeat(40),
  executionEnabled: false,
  worktreeCreated: true,
};

describe('WorktreeHydrationPanel', () => {
  it('requires an explicit checkbox and secret before exposing hydration grant', () => {
    const html = renderToStaticMarkup(
      <WorktreeHydrationPanel sessionId={base.sessionId} plan={base}
        completed={false} onRefresh={async () => undefined} />,
    );
    expect(html).toContain('Контрольоване наповнення worktree');
    expect(html).toContain('type="password"');
    expect(html).toContain('Окремо авторизувати наповнення');
    expect(html).toContain('disabled');
    expect(html).not.toContain('Записати Git-файли в worktree');
  });

  it('renders a terminal failure without any action that can overwrite partial files', () => {
    const html = renderToStaticMarkup(
      <WorktreeHydrationPanel sessionId={base.sessionId}
        plan={{ ...base, hydrationState: 'failed', hydrationFiles: 1, hydrationBytes: 24 }}
        completed={false} onRefresh={async () => undefined} />,
    );
    expect(html).toContain('потрібна ручна перевірка');
    expect(html).toContain('Повторний запис і автоматичне очищення вимкнені');
    expect(html).not.toContain('Окремо авторизувати наповнення');
  });
});
