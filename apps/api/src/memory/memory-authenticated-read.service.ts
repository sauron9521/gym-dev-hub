import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MemoryReadQuerySchema } from '@gym-dev-hub/contracts';
import type { MemoryReadPage } from '@gym-dev-hub/contracts';
import pg from 'pg';
import { ZodError } from 'zod';
import { resolveMemoryDatabaseConfiguration } from '../database/memory-database-policy.js';
import { MemoryAuthorizationService } from '../security/memory-authorization.service.js';
import {
  authenticateMemoryHttpRead,
  toMemoryHttpException,
} from '../security/memory-http-identity.js';
import type { MemoryHttpReadRequest } from '../security/memory-http-identity.js';
import { verifyMemoryPrincipalBinding } from '../security/memory-principal-binding.js';
import { MemorySecurityError } from '../security/memory-security-policy.js';
import {
  MemoryQueryService,
  MemoryReadNotFoundError,
  MemoryReadValidationError,
} from './memory-query.service.js';

type PoolFactory = (url: string) => pg.Pool;

/**
 * Single, independently opted-in HTTP read gateway. Bearer scope is never
 * accepted from URL/query/headers; identity is reverified against Hub DB for
 * each request. No write, MCP or new agent capability is exposed.
 */
export class MemoryAuthenticatedReadService {
  private readonly cursorKey = randomBytes(32);

  constructor(
    private readonly authorization: MemoryAuthorizationService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly makePool: PoolFactory = (url) =>
      new pg.Pool({
        connectionString: url,
        ssl: false,
        max: 1,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 1000,
      }),
  ) {}

  async list(request: MemoryHttpReadRequest, filters: unknown): Promise<MemoryReadPage> {
    // An issued credential does not implicitly enable HTTP memory reads.
    if (this.env.DEV_HUB_MEMORY_READ_HTTP_ENABLE !== 'true')
      throw new ServiceUnavailableException('Memory HTTP reads disabled');

    const principal = authenticateMemoryHttpRead(request, this.authorization, this.env);
    const parsed = MemoryReadQuerySchema.safeParse(filters);
    if (!parsed.success) throw new BadRequestException('Invalid memory query');

    // Uniform 404 before touching the DB for a cross-scope query.
    if (
      parsed.data.repository !== principal.repository ||
      (parsed.data.taskId && parsed.data.taskId !== principal.readContext.taskId)
    ) {
      throw new NotFoundException('Memory records not found');
    }

    let pool: pg.Pool | undefined;
    try {
      const config = resolveMemoryDatabaseConfiguration(this.env);
      if (!config.enabled) throw new MemorySecurityError('disabled');
      pool = this.makePool(config.url);

      await verifyMemoryPrincipalBinding(principal, pool);
      const query = new MemoryQueryService(pool, this.cursorKey);
      return await query.list(principal.readContext, parsed.data);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      if (error instanceof MemoryReadNotFoundError)
        throw new NotFoundException('Memory records not found');
      if (error instanceof MemoryReadValidationError || error instanceof ZodError)
        throw new BadRequestException('Invalid memory query or cursor');
      // Do not return connection strings, SQL errors or private source data.
      throw new ServiceUnavailableException('Memory read unavailable');
    } finally {
      if (pool) {
        try {
          await pool.end();
        } catch {
          // Connection cleanup failure must not leak raw database details.
        }
      }
    }
  }
}
