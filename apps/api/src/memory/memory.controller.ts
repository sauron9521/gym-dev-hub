import type { IncomingMessage } from 'node:http';
import {
  Controller,
  Get,
  Header,
  Inject,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MemoryAuthenticatedReadService } from './memory-authenticated-read.service.js';

type LocalRequest = IncomingMessage & { originalUrl?: string };
const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Repository-scoped HTTP list is independently opt-in. Detail/revision reads
 * stay disabled until their separate, request-level authorization review.
 */
@Controller('v1/memory')
export class MemoryController {
  constructor(
    @Inject(MemoryAuthenticatedReadService)
    private readonly reads: MemoryAuthenticatedReadService,
  ) {}

  private disabled(): never {
    throw new ServiceUnavailableException('Shared Agent Memory detail reads disabled');
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  list(@Req() request: LocalRequest, @Query() filters: Record<string, unknown>) {
    return this.reads.list(
      {
        method: request.method ?? '',
        host: single(request.headers.host),
        remoteAddress: request.socket.remoteAddress,
        origin: single(request.headers.origin),
        fetchSite: single(request.headers['sec-fetch-site']),
        path: request.originalUrl ?? request.url ?? '',
        authorization: single(request.headers.authorization),
      },
      filters,
    );
  }

  @Get(':id/revisions')
  revisions(): never {
    return this.disabled();
  }

  @Get(':id')
  get(): never {
    return this.disabled();
  }
}
