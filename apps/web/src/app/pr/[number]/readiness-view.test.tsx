import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PullReadiness } from '@gym-dev-hub/contracts';
import { ReadinessView } from './readiness-view';

const snapshot: PullReadiness = {
  repository: 'sauron9521/gym-platform',
  number: 42,
  title: 'Fix CI gates',
  url: 'https://github.com/sauron9521/gym-platform/pull/42',
  baseBranch: 'main',
  headSha: 'abc123ef',
  draft: false,
  mergeable: true,
  mergeableState: 'clean',
  fetchedAt: '2026-11-19T20:00:00Z',
  checks: [
    {
      name: 'Verify (Node 24)',
      provider: 'github-actions',
      source: 'check-run',
      appId: 42,
      state: 'success',
      detail: 'success',
      url: 'https://github.com/example/actions',
    },
  ],
  checksState: 'success',
  requiredChecks: [{ name: 'Verify (Node 24)', appId: 42, state: 'success' }],
  requiredState: 'success',
  policy: 'classic-required',
  verdict: 'ready-for-review',
  reasons: ['Відомі перевірки завершилися успішно.'],
  unavailable: [],
};

describe('ReadinessView', () => {
  it('shows required checks, SHA and manual review, without merge action', () => {
    const markup = renderToStaticMarkup(
      <ReadinessView
        repository="sauron9521/gym-platform"
        number="42"
        data={snapshot}
        error={null}
      />,
    );
    expect(markup).toContain('abc123ef');
    expect(markup).toContain('Verify (Node 24)');
    expect(markup).toContain('Можна передавати на review');
    expect(markup).toContain('Відкрити PR на GitHub');
    expect(markup).toContain('лише вручну');
  });

  it('shows unknown state when branch rules are inaccessible', () => {
    const markup = renderToStaticMarkup(
      <ReadinessView
        repository="sauron9521/gym-platform"
        number="42"
        data={{
          ...snapshot,
          verdict: 'unknown',
          policy: 'unavailable',
          unavailable: ['branch-protection'],
        }}
        error={null}
      />,
    );
    expect(markup).toContain('Готовність не підтверджена');
    expect(markup).toContain('branch-protection');
  });

  it('shows an API error rather than an invented green status', () => {
    const markup = renderToStaticMarkup(
      <ReadinessView
        repository="sauron9521/gym-platform"
        number="42"
        data={null}
        error="API offline"
      />,
    );
    expect(markup).toContain('API offline');
    expect(markup).not.toContain('Можна передавати на review');
  });
});
