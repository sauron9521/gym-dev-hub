import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorktreeCommitCandidateAcknowledgement } from '@gym-dev-hub/contracts';
import { CodexCommitWritePanel } from './codex-commit-write-panel';

const reviewed: WorktreeCommitCandidateAcknowledgement = {
  candidateId: '00000000-0000-4000-8000-000000000987',
  candidateSha256: 'a'.repeat(64),
  commitSubject: 'fix(api): reviewed local commit',
  acknowledgedAt: '2026-11-21T08:00:00.000Z',
  status: 'operator-reviewed',
  previewOnly: true,
  commitCreated: false,
  stagingEnabled: false,
  pushEnabled: false,
  mergeEnabled: false,
};

describe('explicit local Git commit owner-only UI', () => {
  it('initially shows no active write/grant and requires three secrets and explicit consent', () => {
    const html = renderToStaticMarkup(
      <CodexCommitWritePanel
        sessionId="00000000-0000-4000-8000-000000000456"
        planId="00000000-0000-4000-8000-000000000123"
        reviewed={reviewed}
      />,
    );
    expect(html).toContain('Контрольований локальний Git commit');
    expect(html).toContain('Дозволити один Git commit');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled');
    expect((html.match(/type="password"/g) ?? []).length).toBe(3);
    expect((html.match(/autoComplete="off"/g) ?? []).length).toBe(3);
    expect(html).toContain('fix(api): reviewed local commit');
    expect(html).not.toContain('git push origin');
    expect(html).not.toContain('Злити');
    expect(html).not.toContain('Створити цей локальний commit');
  });
});
