import type { IncomingMessage } from 'node:http';
import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MemoryAuthenticatedReadService } from './memory-authenticated-read.service.js';

type LocalRequest = IncomingMessage & { originalUrl?: string };
const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Verified-only list/detail/revisions share a separately opted-in bearer/DB read gateway. */
@Controller('v1/memory')
export class MemoryController {
  constructor(
    @Inject(MemoryAuthenticatedReadService)
    private readonly reads: MemoryAuthenticatedReadService,
  ) {}

  private requestContext(request: LocalRequest) {
    return {
      method: request.method ?? '',
      host: single(request.headers.host),
      remoteAddress: request.socket.remoteAddress,
      origin: single(request.headers.origin),
      fetchSite: single(request.headers['sec-fetch-site']),
      path: request.originalUrl ?? request.url ?? '',
      authorization: single(request.headers.authorization),
    };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  list(@Req() request: LocalRequest, @Query() filters: Record<string, unknown>) {
    return this.reads.list(this.requestContext(request), filters);
  }

  // A static reserved route must not be mistaken for a record UUID.
  @Get('status')
  status(): never {
    throw new ServiceUnavailableException('Shared Agent Memory status disabled');
  }

  @Get(':id/revisions')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  revisions(
    @Req() request: LocalRequest,
    @Query() filters: Record<string, unknown>,
    @Param('id') id: string,
  ) {
    return this.reads.revisions(this.requestContext(request), filters, id);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  get(
    @Req() request: LocalRequest,
    @Query() filters: Record<string, unknown>,
    @Param('id') id: string,
  ) {
    return this.reads.get(this.requestContext(request), filters, id);
  }
}
