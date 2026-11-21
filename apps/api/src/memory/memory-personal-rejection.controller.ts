import type { IncomingMessage } from 'node:http';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { MemoryApprovalService } from './memory-approval.service.js';
import { MemoryPersonalRejectionService } from './memory-personal-rejection.service.js';
import { MemorySecurityError } from '../security/memory-security-policy.js';
import { toMemoryHttpException } from '../security/memory-http-identity.js';

type LocalRequest = IncomingMessage & { originalUrl?: string };
const header = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);
function requestToken(request: LocalRequest, boundary: MemoryApprovalService): string | undefined {
  try {
    boundary.assertLocalOperatorHttp({
      method: request.method ?? '',
      host: header(request.headers.host),
      remoteAddress: request.socket.remoteAddress,
      origin: header(request.headers.origin),
      fetchSite: header(request.headers['sec-fetch-site']),
      path: request.originalUrl ?? request.url ?? '',
    });
    const contentType = header(request.headers['content-type']);
    if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType))
      throw new MemorySecurityError('forbidden');
    // No cookies, root secret, shared-root approval grant or query credentials.
    if (
      request.headers.cookie ||
      request.headers['x-dev-hub-memory-operator-secret'] ||
      request.headers['x-dev-hub-memory-approval-grant']
    )
      throw new MemorySecurityError('forbidden');
    const authorization = header(request.headers.authorization);
    if (!authorization || !/^Bearer mop_[A-Za-z0-9_-]{43}$/.test(authorization))
      throw new MemorySecurityError('unauthorized');
    return authorization.slice('Bearer '.length);
  } catch (error) {
    throw toMemoryHttpException(error);
  }
}
function safe(error: unknown): HttpException {
  return error instanceof HttpException ? error : toMemoryHttpException(error);
}

/** Separate URL prefix prevents old shared-root grant reuse. */
@Controller('v1/memory/operator/personal-rejection-grants')
export class MemoryPersonalRejectionGrantController {
  constructor(
    @Inject(MemoryPersonalRejectionService)
    private readonly personal: MemoryPersonalRejectionService,
    @Inject(MemoryApprovalService) private readonly boundary: MemoryApprovalService,
  ) {}
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async review(@Req() request: LocalRequest, @Body() input: unknown) {
    const token = requestToken(request, this.boundary);
    try {
      return await this.personal.reviewAndGrant(token, input);
    } catch (error) {
      throw safe(error);
    }
  }
}

@Controller('v1/memory')
export class MemoryPersonalRejectionController {
  constructor(
    @Inject(MemoryPersonalRejectionService)
    private readonly personal: MemoryPersonalRejectionService,
    @Inject(MemoryApprovalService) private readonly boundary: MemoryApprovalService,
  ) {}
  @Post(':id/personal-reject')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async reject(@Req() request: LocalRequest, @Param('id') id: string, @Body() input: unknown) {
    const token = requestToken(request, this.boundary);
    try {
      return await this.personal.reject(
        token,
        header(request.headers['x-dev-hub-memory-personal-grant']),
        id,
        input,
      );
    } catch (error) {
      throw safe(error);
    }
  }
}
