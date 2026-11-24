import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ segments: string[] }> };

function allowedPath(segments: string[], method: string): string | null {
  if (segments.length === 2 && segments[0] === 'codex') {
    if (segments[1] === 'status' && method === 'GET') return '/workspace/codex/status';
    if (segments[1] === 'connect' && method === 'POST') return '/workspace/codex/connect';
  }
  if (segments.length === 2 && segments[0] === 'worker') {
    if (segments[1] === 'status' && method === 'GET') return '/workspace/worker/status';
    if (['start', 'ping', 'stop'].includes(segments[1]) && method === 'POST') {
      return `/workspace/worker/${segments[1]}`;
    }
  }
  if (segments.length === 2 && segments[0] === 'boundary') {
    if (segments[1] === 'status' && method === 'GET') return '/workspace/boundary/status';
    if (segments[1] === 'preflight' && method === 'POST') return '/workspace/boundary/preflight';
  }
  if (segments.length === 1 && segments[0] === 'workflow-readiness' && method === 'GET') {
    return '/workspace/sessions/workflow-readiness';
  }
  if (segments[0] !== 'sessions') return null;
  if (segments.length === 1 && (method === 'GET' || method === 'POST')) {
    return '/workspace/sessions';
  }

  const id = segments[1];
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  ) {
    return null;
  }

  if (segments.length === 2 && (method === 'GET' || method === 'PATCH')) {
    return `/workspace/sessions/${id}`;
  }
  if (segments.length === 3 && segments[2] === 'chat' && ['POST', 'GET'].includes(method)) {
    return `/workspace/sessions/${id}/chat`;
  }
  if (
    segments.length === 4 &&
    segments[2] === 'chat' &&
    segments[3] === 'events' &&
    method === 'GET'
  ) {
    return `/workspace/sessions/${id}/chat/events`;
  }
  if (
    segments.length === 3 &&
    segments[2] === 'worktree-plans' &&
    ['GET', 'POST'].includes(method)
  ) {
    return `/workspace/sessions/${id}/worktree-plans`;
  }
  if (
    segments.length === 5 &&
    segments[2] === 'worktree-plans' &&
    method === 'POST' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      segments[3] ?? '',
    ) &&
    [
      'acknowledge',
      'revoke',
      'authorize',
      'create',
      'hydration-authorize',
      'hydrate',
      'mount-authorize',
      'mount-probe',
      'code-read-authorize',
      'code-read',
      'patch-preflight',
      'patch-apply-authorize',
      'patch-apply',
      'patch-review',
      'patch-recover',
      'patch-check-authorize',
      'patch-check-execute',
      'patch-check-cancel',
      'patch-check-history',
      'commit-candidate-preview',
      'commit-candidate-acknowledge',
      'commit-write-authorize',
      'commit-write-execute',
      'github-push-authorize',
      'github-push-execute',
      'github-draft-pr-authorize',
      'github-draft-pr-execute',
      'github-draft-pr-ci',
      'tool-authorize',
      'tool-execute',
      'task-preview',
    ].includes(segments[4] ?? '')
  ) {
    return `/workspace/sessions/${id}/worktree-plans/${segments[3]}/${segments[4]}`;
  }
  if (
    segments.length === 5 &&
    segments[2] === 'worktree-plans' &&
    method === 'GET' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      segments[3] ?? '',
    ) &&
    ['inspection', 'integrity'].includes(segments[4] ?? '')
  ) {
    return `/workspace/sessions/${id}/worktree-plans/${segments[3]}/${segments[4]}`;
  }
  if (segments.length === 3 && segments[2] === 'codex' && method === 'POST') {
    return `/workspace/sessions/${id}/codex`;
  }
  if (segments.length === 3 && segments[2] === 'messages' && method === 'POST') {
    return `/workspace/sessions/${id}/messages`;
  }
  return null;
}

async function forward(request: NextRequest, context: Context, method: 'GET' | 'POST' | 'PATCH') {
  const { segments } = await context.params;
  const path = allowedPath(segments, method);
  if (!path) {
    return Response.json({ message: 'Недозволений маршрут Workspace' }, { status: 404 });
  }

  const isWrite = method !== 'GET';
  if (isWrite) {
    const origin = request.headers.get('origin');
    if (origin && origin !== request.nextUrl.origin) {
      return Response.json({ message: 'Cross-origin write request rejected' }, { status: 403 });
    }
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      return Response.json({ message: 'Очікується application/json' }, { status: 415 });
    }
  }

  let body: string | undefined;
  if (isWrite) {
    const statedLength = Number(request.headers.get('content-length') ?? 0);
    const maxBodyLength = ['/patch-preflight', '/patch-apply-authorize', '/patch-apply'].some(
      (end) => path.endsWith(end),
    )
      ? 30_000
      : 10_000;
    if (statedLength > maxBodyLength) {
      return Response.json({ message: 'Завелике тіло запиту' }, { status: 413 });
    }
    body = await request.text();
    if (body.length > maxBodyLength) {
      return Response.json({ message: 'Завелике тіло запиту' }, { status: 413 });
    }
  }

  try {
    const isEventStream = path.endsWith('/chat/events');
    const endpoint = new URL(path, process.env.DEV_HUB_API_URL ?? 'http://127.0.0.1:3101');
    const upstream = await fetch(endpoint, {
      method,
      headers: {
        Accept: 'application/json',
        ...(isWrite ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      cache: 'no-store',
      signal: isEventStream
        ? request.signal
        : AbortSignal.timeout(
            path.endsWith('/commit-write-authorize') ||
              path.endsWith('/commit-write-execute') ||
              path.endsWith('/github-push-authorize') ||
              path.endsWith('/github-push-execute') ||
              path.endsWith('/github-draft-pr-authorize') ||
              path.endsWith('/github-draft-pr-execute') ||
              path.endsWith('/github-draft-pr-ci')
              ? 120_000
              : path.endsWith('/mount-probe') ||
                  path.endsWith('/code-read') ||
                  path.endsWith('/commit-candidate-preview') ||
                  path.endsWith('/commit-candidate-acknowledge') ||
                  path.endsWith('/tool-execute')
                ? 45_000
                : path.endsWith('/boundary/preflight')
                  ? 45_000
                  : path.endsWith('/hydrate')
                    ? 300_000
                    : path.includes('codex') || path.endsWith('/chat')
                      ? 20_000
                      : 10_000,
          ),
      redirect: 'error',
    });
    if (isEventStream && upstream.ok) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      });
    }
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json(
      { message: 'API Dev Hub зараз недоступний. Запусти NestJS.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export async function GET(request: NextRequest, context: Context) {
  return forward(request, context, 'GET');
}

export async function POST(request: NextRequest, context: Context) {
  return forward(request, context, 'POST');
}

export async function PATCH(request: NextRequest, context: Context) {
  return forward(request, context, 'PATCH');
}
