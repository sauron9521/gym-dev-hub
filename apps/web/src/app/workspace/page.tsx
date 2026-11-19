import type { WorkspaceOverview } from '@gym-dev-hub/contracts';
import { WorkspaceClient } from './workspace-client';

export const dynamic = 'force-dynamic';

async function getWorkspace(): Promise<{ initial: WorkspaceOverview; error: string | null }> {
  const fallback: WorkspaceOverview = { repositories: [], sessions: [] };
  try {
    const endpoint = new URL(
      '/workspace/sessions',
      process.env.DEV_HUB_API_URL ?? 'http://127.0.0.1:3101',
    );
    const response = await fetch(endpoint, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { initial: fallback, error: 'Не вдалося відкрити локальне сховище сесій.' };
    }
    return { initial: (await response.json()) as WorkspaceOverview, error: null };
  } catch {
    return { initial: fallback, error: 'NestJS API недоступний. Запусти pnpm dev.' };
  }
}

export default async function WorkspacePage() {
  const { initial, error } = await getWorkspace();
  return <WorkspaceClient initial={initial} initialError={error} />;
}
