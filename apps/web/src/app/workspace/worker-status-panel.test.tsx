import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkerStatusPanel } from './worker-status-panel';

describe('WorkerStatusPanel', () => {
  it('renders fixed-protocol lifecycle controls with no command execution', () => {
    const html = renderToStaticMarkup(<WorkerStatusPanel />);
    expect(html).toContain('Isolated Agent Worker');
    expect(html).toContain('Запустити worker');
    expect(html).toContain('Перевірити зв’язок');
    expect(html).toContain('Зупинити worker');
    expect(html).toContain('Виконання агентських задач: вимкнено');
    expect(html).toContain('No host mounts');
    expect(html).not.toContain('Виконати команду агента');
  });
});
