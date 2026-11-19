import type { PullReadiness } from '@gym-dev-hub/contracts';
import { ReadinessView } from './readiness-view';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ repository?: string | string[] }>;
}

export default async function PullReadinessPage({ params, searchParams }: PageProps) {
  const { number } = await params;
  const { repository } = await searchParams;
  const selected = typeof repository === 'string' ? repository : 'sauron9521/gym-dev-hub';
  const endpoint = new URL(
    '/github/readiness',
    process.env.DEV_HUB_API_URL ?? 'http://127.0.0.1:3101',
  );
  endpoint.searchParams.set('repository', selected);
  endpoint.searchParams.set('number', number);

  let data: PullReadiness | null = null;
  let error: string | null = null;
  try {
    const response = await fetch(endpoint, {
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      data = (await response.json()) as PullReadiness;
    } else {
      error =
        response.status === 400
          ? 'Репозиторій або PR недоступні для перевірки.'
          : 'GitHub API не надав достатньо даних для відкриття цього PR.';
    }
  } catch {
    error = 'Локальний API Dev Hub недоступний. Запусти pnpm dev.';
  }
  return <ReadinessView repository={selected} number={number} data={data} error={error} />;
}
