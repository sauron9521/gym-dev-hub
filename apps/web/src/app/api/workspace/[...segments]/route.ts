import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ segments: string[] }> };

function allowedPath(segments: string[], method: string): string | null {
  if (segments.length === 2 && segments[0] === 'codex') {
    if (segments[1] === 'status' && method === 'GET') return '/workspace/codex/status';
    if (segments[1] === 'connect' && method === 'POST') return '/workspace/codex/connect';
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
    if (statedLength > 10_000) {
      return Response.json({ message: 'Завелике тіло запиту' }, { status: 413 });
    }
    body = await request.text();
    if (body.length > 10_000) {
      return Response.json({ message: 'Завелике тіло запиту' }, { status: 413 });
    }
  }

  try {
    const endpoint = new URL(path, process.env.DEV_HUB_API_URL ?? 'http://127.0.0.1:3101');
    const upstream = await fetch(endpoint, {
      method,
      headers: {
        Accept: 'application/json',
        ...(isWrite ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(path.includes('codex') ? 20_000 : 10_000),
      redirect: 'error',
    });
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
