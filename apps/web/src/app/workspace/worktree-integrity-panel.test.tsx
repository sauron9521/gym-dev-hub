import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorktreeIntegrityPanel } from './worktree-integrity-panel';

describe('WorktreeIntegrityPanel', () => {
  it('offers only read-only verification, never a worker mount or agent execution button', () => {
    const markup = renderToStaticMarkup(
      <WorktreeIntegrityPanel
        sessionId="00000000-0000-4000-8000-000000000456"
        planId="00000000-0000-4000-8000-000000000123"
      />,
    );
    expect(markup).toContain('Перевірка файлів і майбутнього mount');
    expect(markup).toContain('Звірити з Git');
    expect(markup).toContain('не монтує каталоги');
    expect(markup).not.toContain('Монтувати worktree');
    expect(markup).not.toContain('Запустити агента');
  });
});
