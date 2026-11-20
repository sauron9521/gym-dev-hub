import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorktreeInspectionPanel } from './worktree-inspection-panel';

describe('WorktreeInspectionPanel', () => {
  it('offers read-only recovery inspection without checkout or cleanup actions', () => {
    const html = renderToStaticMarkup(
      <WorktreeInspectionPanel
        sessionId="00000000-0000-4000-8000-000000000456"
        planId="00000000-0000-4000-8000-000000000123"
      />,
    );
    expect(html).toContain('Перевірка worktree та відновлення');
    expect(html).toContain('Перевірити готовність');
    expect(html).toContain('Checkout, cleanup і доступ агента залишаються вимкненими');
    expect(html).not.toContain('Створити checkout');
    expect(html).not.toContain('Видалити worktree');
  });
});
