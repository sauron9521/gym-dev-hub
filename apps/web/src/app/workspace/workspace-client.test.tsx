import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkspaceOverview } from '@gym-dev-hub/contracts';
import { WorkspaceClient } from './workspace-client';

const overview: WorkspaceOverview = {
  repositories: ['sauron9521/gym-platform', 'sauron9521/gym-dev-hub'],
  sessions: [
    {
      id: '00000000-0000-4000-8000-000000000042',
      repository: 'sauron9521/gym-platform',
      title: 'Mobile workout UI',
      task: 'One PR for a native mobile UX refinement',
      status: 'in-progress',
      messageCount: 2,
      createdAt: '2026-11-19T20:00:00.000Z',
      updatedAt: '2026-11-19T20:15:00.000Z',
    },
  ],
};

describe('Workspace foundation UI', () => {
  it('renders saved sessions and separate tab controls without pretending AI is connected', () => {
    const html = renderToStaticMarkup(<WorkspaceClient initial={overview} initialError={null} />);
    expect(html).toContain('Mobile workout UI');
    expect(html).toContain('Окремі задачі');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('Закрити вкладку');
    expect(html).toContain('Поки без Codex');
    expect(html).toContain('2 нотаток');
  });

  it('renders an empty state and exposes session creation', () => {
    const html = renderToStaticMarkup(
      <WorkspaceClient
        initial={{ sessions: [], repositories: overview.repositories }}
        initialError={null}
      />,
    );
    expect(html).toContain('Створи сесію');
    expect(html).toContain('Нова сесія');
    expect(html).not.toContain('Mobile workout UI');
  });

  it('visibly reports API failures', () => {
    const html = renderToStaticMarkup(
      <WorkspaceClient
        initial={{ sessions: [], repositories: [] }}
        initialError="NestJS API offline"
      />,
    );
    expect(html).toContain('NestJS API offline');
  });
});
