import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import {
  MemoryReadContextSchema,
  MemoryReadPageSchema,
  MemoryReadQuerySchema,
  MemoryReadItemSchema,
  MemoryReadRevisionsSchema,
} from '@gym-dev-hub/contracts';
import type {
  MemoryReadContext,
  MemoryReadQuery,
  MemoryReadItem,
  MemoryReadPage,
  MemoryReadRevisions,
} from '@gym-dev-hub/contracts';

/**
 * Unwired repository-scoped query engine for future authenticated handlers.
 * No Nest provider or public HTTP route may call this before Issue #39.
 * The context must be built from an authenticated principal, NOT query params.
 */
export class MemoryQueryService {
  constructor(
    private readonly db: pg.Pool,
    private readonly cursorKey: Buffer,
  ) {
    if (cursorKey.length < 32) throw new Error('Cursor signing key must contain 32 or more bytes');
  }

  private readonly recordProjection = `
    SELECT r.id, r.repository, r.scope::text AS scope, r.kind::text AS kind,
      r.status::text AS status, r.text, r.revision, r.task_id, r.session_id,
      r.agent_id, r.source_sha, r.superseded_by_id, r.expires_at, r.verified_by,
      r.verified_at, r.created_at, r.updated_at,
      s.id AS provenance_id, s.source_type::text AS source_type, s.actor_id,
      s.source_ref, s.source_sha AS provenance_source_sha,
      s.observed_at, s.created_at AS provenance_created_at
    FROM memory_records r
    JOIN LATERAL (
      SELECT id, source_type, actor_id, source_ref, source_sha, observed_at, created_at
      FROM memory_sources
      WHERE repository=r.repository AND memory_id=r.id
      ORDER BY observed_at DESC, id DESC LIMIT 1
    ) s ON TRUE
    WHERE r.repository=$1::text AND r.status='VERIFIED'
      AND r.verified_by IS NOT NULL AND r.verified_at IS NOT NULL
      AND (r.expires_at IS NULL OR r.expires_at > NOW())
      AND (s.source_type <> 'GITHUB' OR s.observed_at >= NOW() - INTERVAL '60 seconds')
      AND (r.agent_id IS NULL OR r.agent_id=$4::uuid)
      AND (
        (r.scope='PROJECT' AND r.task_id IS NULL AND r.session_id IS NULL)
        OR (r.scope='TASK' AND $2::uuid IS NOT NULL AND r.task_id=$2::uuid)
        OR (r.scope='SESSION' AND $3::uuid IS NOT NULL AND r.session_id=$3::uuid)
      )
      AND ($5::text IS NULL OR r.scope::text=$5::text)
      AND ($6::text IS NULL OR r.kind::text=$6::text)
      AND ($7::uuid IS NULL OR (r.scope='TASK' AND r.task_id=$7::uuid))
  `;

  private static iso(value: Date | string): string {
    return new Date(value).toISOString();
  }

  private map(row: Record<string, unknown>): MemoryReadItem {
    const iso = MemoryQueryService.iso;
    return MemoryReadItemSchema.parse({
      record: {
        schemaVersion: 1,
        id: row.id,
        repository: row.repository,
        scope: String(row.scope).toLowerCase(),
        kind: String(row.kind).toLowerCase(),
        status: String(row.status).toLowerCase(),
        text: row.text,
        revision: row.revision,
        taskId: row.task_id,
        sessionId: row.session_id,
        agentId: row.agent_id,
        sourceSha: row.source_sha,
        supersededById: row.superseded_by_id,
        expiresAt: row.expires_at ? iso(row.expires_at as Date) : null,
        verifiedBy: row.verified_by,
        verifiedAt: iso(row.verified_at as Date),
        createdAt: iso(row.created_at as Date),
        updatedAt: iso(row.updated_at as Date),
      },
      provenance: {
        schemaVersion: 1,
        id: row.provenance_id,
        repository: row.repository,
        memoryId: row.id,
        sourceType: String(row.source_type).toLowerCase(),
        actorId: row.actor_id,
        sourceRef: row.source_ref,
        sourceSha: row.provenance_source_sha,
        observedAt: iso(row.observed_at as Date),
        createdAt: iso(row.provenance_created_at as Date),
      },
      freshness: { sourceObservedAt: iso(row.observed_at as Date), sourceStale: false },
    });
  }

  private context(value: unknown): MemoryReadContext {
    return MemoryReadContextSchema.parse(value);
  }

  private signature(data: string): string {
    return createHmac('sha256', this.cursorKey).update(data).digest('hex');
  }

  private fingerprint(
    ctx: MemoryReadContext,
    filters: Omit<MemoryReadQuery, 'cursor' | 'limit'>,
  ): string {
    return createHash('sha256').update(JSON.stringify({ ctx, filters })).digest('hex');
  }

  private encodeCursor(data: {
    repository: string;
    fingerprint: string;
    updatedAt: string;
    id: string;
  }): string {
    const body = JSON.stringify({ version: 1, ...data });
    return Buffer.from(JSON.stringify({ body, mac: this.signature(body) })).toString('base64url');
  }

  private decodeCursor(
    token: string,
    fingerprint: string,
    repository: string,
  ): { updatedAt: string; id: string } {
    try {
      const raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
        body: unknown;
        mac: unknown;
      };
      if (
        typeof raw.body !== 'string' ||
        typeof raw.mac !== 'string' ||
        !/^[0-9a-f]{64}$/.test(raw.mac)
      )
        throw new Error('invalid envelope');
      const expected = Buffer.from(this.signature(raw.body), 'hex');
      const supplied = Buffer.from(raw.mac, 'hex');
      if (!timingSafeEqual(expected, supplied)) throw new Error('bad signature');
      const payload = z
        .object({
          version: z.literal(1),
          repository: z.string(),
          fingerprint: z.string(),
          updatedAt: z.iso.datetime({ offset: true }),
          id: z.uuid(),
        })
        .strict()
        .parse(JSON.parse(raw.body));
      if (payload.repository !== repository || payload.fingerprint !== fingerprint)
        throw new Error('cursor wrong scope');
      return { updatedAt: payload.updatedAt, id: payload.id };
    } catch {
      throw new MemoryReadValidationError('Invalid or expired-scoped pagination cursor');
    }
  }

  private authorize(ctx: MemoryReadContext, repository: string, taskId?: string): void {
    // Caller context is trusted only when installed behind #39 auth.
    if (ctx.repository !== repository || (taskId && ctx.taskId !== taskId))
      throw new MemoryReadNotFoundError();
  }

  async list(context: unknown, rawQuery: unknown): Promise<MemoryReadPage> {
    const ctx = this.context(context);
    const query = MemoryReadQuerySchema.parse(rawQuery);
    this.authorize(ctx, query.repository, query.taskId);
    const filters = {
      repository: query.repository,
      scope: query.scope,
      taskId: query.taskId,
      kind: query.kind,
    };
    const fp = this.fingerprint(ctx, filters);
    const cursor = query.cursor ? this.decodeCursor(query.cursor, fp, ctx.repository) : undefined;
    const params = [
      ctx.repository,
      ctx.taskId ?? null,
      ctx.sessionId ?? null,
      ctx.agentId ?? null,
      query.scope?.toUpperCase() ?? null,
      query.kind?.toUpperCase() ?? null,
      query.taskId ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      query.limit + 1,
    ];
    const sql =
      this.recordProjection +
      `
      AND ($8::timestamptz IS NULL OR
        r.updated_at < $8::timestamptz OR
        (r.updated_at = $8::timestamptz AND r.id < $9::uuid))
      ORDER BY r.updated_at DESC,r.id DESC LIMIT $10::integer`;
    const result = await this.db.query(sql, params);
    const visible = result.rows.slice(0, query.limit).map((row) => this.map(row));
    const last = visible.at(-1);
    const nextCursor =
      result.rows.length > query.limit && last
        ? this.encodeCursor({
            repository: ctx.repository,
            fingerprint: fp,
            updatedAt: last.record.updatedAt,
            id: last.record.id,
          })
        : null;
    return MemoryReadPageSchema.parse({
      schemaVersion: 1,
      repository: ctx.repository,
      items: visible,
      nextCursor,
    });
  }

  async get(context: unknown, repository: string, id: string): Promise<MemoryReadItem> {
    const ctx = this.context(context);
    const args = MemoryReadQuerySchema.pick({ repository: true })
      .extend({ id: z.uuid() })
      .parse({ repository, id });
    this.authorize(ctx, args.repository);
    const sql = this.recordProjection + ' AND r.id=$8::uuid LIMIT 1';
    const result = await this.db.query(sql, [
      ctx.repository,
      ctx.taskId ?? null,
      ctx.sessionId ?? null,
      ctx.agentId ?? null,
      null,
      null,
      null,
      id,
    ]);
    if (!result.rows[0]) throw new MemoryReadNotFoundError();
    return this.map(result.rows[0]);
  }

  async revisions(context: unknown, repository: string, id: string): Promise<MemoryReadRevisions> {
    const ctx = this.context(context);
    const record = await this.get(ctx, repository, id);
    const result = await this.db.query(
      `
      SELECT id,repository,memory_id,revision,scope::text AS scope,kind::text AS kind,
        status::text AS status,text,source_sha,source_id,changed_by,created_at
      FROM memory_revisions
      WHERE repository=$1 AND memory_id=$2 AND status='VERIFIED'
      ORDER BY revision ASC
      LIMIT 100`,
      [ctx.repository, record.record.id],
    );
    return MemoryReadRevisionsSchema.parse({
      schemaVersion: 1,
      repository: ctx.repository,
      memoryId: id,
      revisions: result.rows.map((row) => ({
        schemaVersion: 1,
        id: row.id,
        repository: row.repository,
        memoryId: row.memory_id,
        revision: row.revision,
        scope: String(row.scope).toLowerCase(),
        kind: String(row.kind).toLowerCase(),
        status: String(row.status).toLowerCase(),
        text: row.text,
        sourceSha: row.source_sha,
        sourceId: row.source_id,
        changedBy: row.changed_by,
        createdAt: MemoryQueryService.iso(row.created_at as Date),
      })),
    });
  }
}

export class MemoryReadNotFoundError extends Error {
  constructor() {
    super('Memory record not found');
    this.name = 'MemoryReadNotFoundError';
  }
}
export class MemoryReadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryReadValidationError';
  }
}
