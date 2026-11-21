import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorktreeCodeReadResult } from '@gym-dev-hub/contracts';
import { CodexPatchPreviewPanel } from './codex-patch-preview-panel';

const source: WorktreeCodeReadResult = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  planId: '00000000-0000-4000-8000-000000000002',
  filePath: 'apps/api/src/main.ts',
  content: 'one\n',
  checkedAt: '2026-11-21T01:00:00.000Z',
  readOnly: true,
  networkEnabled: false,
  containerRemoved: true,
  agentExecutionEnabled: false,
};

describe('Codex patch preview UI', () => {
  it('starts empty and only offers a local review button without apply controls', () => {
    const markup = renderToStaticMarkup(
      <CodexPatchPreviewPanel
        source={source}
        sourceCommit={'a'.repeat(40)}
        fingerprint={'sha256:' + 'b'.repeat(64)}
      />,
    );
    expect(markup).toContain('Перевірити запропонований AI-патч');
    expect(markup).toContain('Перевірити і переглянути diff');
    expect(markup).toContain('disabled');
    expect(markup).toContain('maxLength="20000"');
    expect(markup).not.toContain('Застосувати патч');
    expect(markup).not.toContain('Надіслати до Codex');
  });
});
