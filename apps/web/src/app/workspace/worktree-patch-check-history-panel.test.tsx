import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorktreePatchCheckHistoryPanel } from './worktree-patch-check-history-panel';

const sessionId = '00000000-0000-4000-8000-000000000456';
const planId = '00000000-0000-4000-8000-000000000123';

describe('secret-protected patch check history panel', () => {
  it('stays hidden until explicit operator retrieval and has no run/merge controls', () => {
    const html = renderToStaticMarkup(
      <WorktreePatchCheckHistoryPanel sessionId={sessionId} planId={planId} />,
    );
    expect(html).toContain('Історія перевірок Docker');
    expect(html).toContain('Історія Prettier / TypeScript / Vitest перевірок');
    expect(html).toContain('DEV_HUB_PATCH_CHECK_OPERATOR_SECRET');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('Показати журнал');
    expect(html).toContain('disabled');
    expect(html).not.toContain('Запустити');
    expect(html).not.toContain('Злити');
    expect(html).not.toContain(sessionId);
    expect(html).not.toContain(planId);
  });
});
