import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorktreeHydrationPanel } from './worktree-hydration-panel';
import type { WorktreePlan } from '@gym-dev-hub/contracts';

const plan: WorktreePlan = {
  id: '00000000-0000-4000-8000-000000000055',
  sessionId: '00000000-0000-4000-8000-000000000044',
  repository: 'sauron9521/gym-platform',
  sourcePath: '/tmp/fixtures/gym-platform',
  targetPath: '/tmp/worktrees/worktree-1',
  proposedBranch: 'devhub/task-00000000000040008000000000000055',
  fingerprint: 'sha256:' + 'a'.repeat(64),
  state: 'created',
  createdAt: new Date(0).toISOString(),
  expiresAt: null,
  history: [],
  baseHeadSha: 'a'.repeat(40),
  executionEnabled: false,
  worktreeCreated: true,
};

describe('WorktreeHydrationPanel', () => {
  it('does not offer file writes without an explicit preflight and authorization', () => {
    const html = renderToStaticMarkup(
      <WorktreeHydrationPanel
        sessionId={plan.sessionId}
        plan={plan}
        onUpdate={async () => undefined}
      />,
    );
    expect(html).toContain('Перевірити вміст і безпеку');
    expect(html).toContain('Команди агента');
    expect(html).not.toContain('Наповнити Git worktree');
  });

  it('shows recovery guidance without cleanup for interrupted hydration', () => {
    const html = renderToStaticMarkup(
      <WorktreeHydrationPanel
        sessionId={plan.sessionId}
        plan={{ ...plan, state: 'hydrate-failed' }}
        onUpdate={async () => undefined}
      />,
    );
    expect(html).toContain('нічого не видалятиметься автоматично');
  });
});
