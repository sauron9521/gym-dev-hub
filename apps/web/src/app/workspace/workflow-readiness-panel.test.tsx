import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkflowReadinessPanel } from './workflow-readiness-panel';

describe('operator workflow smoke readiness', () => {
  it('starts inert, with read-only refresh and no secret input or automatic write', () => {
    const html = renderToStaticMarkup(<WorkflowReadinessPanel />);
    expect(html).toContain('Готовність наскрізного workflow');
    expect(html).toContain('Перевірка готовності до тестового запуску');
    expect(html).toContain('Перевірити ще раз');
    expect(html).toContain('Реальний E2E: не перевірено');
    expect(html).toContain('не створює файлів');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('github-push-execute');
    expect(html).not.toContain('git commit');
  });
});
