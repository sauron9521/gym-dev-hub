import type { GitHubDashboard } from '@gym-dev-hub/contracts';
import { DashboardView } from './dashboard-view';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ repository?: string | string[] }>;
}

async function loadDashboard(repository?: string): Promise<{
  dashboard: GitHubDashboard | null;
  error: string | null;
}> {
  const base = process.env.DEV_HUB_API_URL ?? 'http://127.0.0.1:3101';
  const url = new URL('/github/dashboard', base);
  if (repository) url.searchParams.set('repository', repository);

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return {
        dashboard: null,
        error:
          response.status === 400
            ? 'Обраний репозиторій не налаштований у Dev Hub.'
            : 'GitHub не відповів або доступ до репозиторію обмежений.',
      };
    }
    return { dashboard: (await response.json()) as GitHubDashboard, error: null };
  } catch {
    return {
      dashboard: null,
      error: 'API Dev Hub недоступний. Перевірте, що NestJS запущений на порту 3101.',
    };
  }
}

export default async function HomePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const repository = typeof params.repository === 'string' ? params.repository : undefined;
  const { dashboard, error } = await loadDashboard(repository);

  return <DashboardView dashboard={dashboard} error={error} selectedRepository={repository} />;
}
