import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BoundaryStatusPanel } from './boundary-status-panel';

describe('BoundaryStatusPanel', () => {
  it('shows a fixed Docker preflight action without offering agent execution', () => {
    const html = renderToStaticMarkup(<BoundaryStatusPanel />);
    expect(html).toContain('Docker Safety Preflight');
    expect(html).toContain('Перевірити ізоляцію');
    expect(html).toContain('Host mounts: none');
    expect(html).toContain('Виконання агентських команд: вимкнено');
    expect(html).not.toContain('Виконати команду агента');
  });
});
