import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import HomePage from './page';

describe('HomePage', () => {
  it('renders the workspace title and next-PR notice', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('<h1>Gym Dev Hub</h1>');
    expect(markup).toContain('GitHub');
  });
});
