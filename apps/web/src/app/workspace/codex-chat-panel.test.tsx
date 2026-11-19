import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodexChatPanel } from './codex-chat-panel';

describe('CodexChatPanel', () => {
  it('renders a text-only chat composer and safety notice', () => {
    const markup = renderToStaticMarkup(
      <CodexChatPanel sessionId="00000000-0000-4000-8000-000000000001" enabled completed={false} />,
    );
    expect(markup).toContain('AI Chat');
    expect(markup).toContain('Надіслати до Codex');
    expect(markup).toContain('Не надсилай секрети');
    expect(markup).toContain('maxLength="3000"');
  });

  it('disables prompts before thread linking and for completed sessions', () => {
    const locked = renderToStaticMarkup(
      <CodexChatPanel
        sessionId="00000000-0000-4000-8000-000000000001"
        enabled={false}
        completed={false}
      />,
    );
    expect(locked).toContain('Спочатку підключи Codex');
    const finished = renderToStaticMarkup(
      <CodexChatPanel sessionId="00000000-0000-4000-8000-000000000001" enabled completed />,
    );
    expect(finished).toContain('Завершена сесія доступна лише для читання');
  });
});
