import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorktreePlanPanel } from './worktree-plan-panel';

describe('WorktreePlanPanel', () => {
  it('shows the scope and explicit approval controls without executing Git', () => {
    const markup = renderToStaticMarkup(
      <WorktreePlanPanel
        sessionId="00000000-0000-4000-8000-000000000055"
        repository="sauron9521/gym-platform"
        completed={false}
      />,
    );
    expect(markup).toContain('План окремої робочої області');
    expect(markup).toContain('Створити план');
    expect(markup).toContain('Погодити план');
    expect(markup).toContain('не завантажує файли проєкту');
    expect(markup).toContain('одноразовий дозвіл');
  });

  it('disables creation for a completed session', () => {
    const markup = renderToStaticMarkup(
      <WorktreePlanPanel
        sessionId="00000000-0000-4000-8000-000000000055"
        repository="sauron9521/gym-platform"
        completed
      />,
    );
    expect(markup).toContain('disabled');
    expect(markup).toContain('gym-platform');
  });
});
