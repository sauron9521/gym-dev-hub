import type { IncomingMessage } from 'node:http';
import { Body, Controller, Header, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { MemoryProposalService } from './memory-proposal.service.js';
import { MemorySecurityError } from '../security/memory-security-policy.js';
import { toMemoryHttpException } from '../security/memory-http-identity.js';

type LocalRequest = IncomingMessage & { originalUrl?: string };
const one = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Agent proposal intake only. No implicit approval, edits, or remote clients.
 * The token and actor are exclusively taken from local Authorization: Bearer.
 */
@Controller('v1/memory/proposals')
export class MemoryProposalController {
  constructor(
    @Inject(MemoryProposalService)
    private readonly proposals: MemoryProposalService,
  ) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  propose(@Req() request: LocalRequest, @Body() body: unknown) {
    const contentType = one(request.headers['content-type']);
    if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType))
      throw toMemoryHttpException(new MemorySecurityError('forbidden'));
    return this.proposals.propose(
      {
        method: request.method ?? '',
        host: one(request.headers.host),
        remoteAddress: request.socket.remoteAddress,
        origin: one(request.headers.origin),
        fetchSite: one(request.headers['sec-fetch-site']),
        path: request.originalUrl ?? request.url ?? '',
        authorization: one(request.headers.authorization),
      },
      one(request.headers['idempotency-key']),
      body,
    );
  }
}
