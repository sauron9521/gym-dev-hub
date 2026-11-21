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
import { MemoryOperatorIdentityService } from './memory-operator-identity.service.js';
import { MemorySecurityError } from './memory-security-policy.js';
import { toMemoryHttpException } from './memory-http-identity.js';

type LocalRequest = IncomingMessage & { originalUrl?: string };
const header = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
function sanitized(error: unknown): HttpException {
  return error instanceof HttpException ? error : toMemoryHttpException(error);
}
function assertRequest(request: LocalRequest, identities: MemoryOperatorIdentityService) {
  try {
    identities.assertLocalHttp({
      method: request.method ?? '',
      host: header(request.headers.host),
      remoteAddress: request.socket.remoteAddress,
      origin: header(request.headers.origin),
      fetchSite: header(request.headers['sec-fetch-site']),
      path: request.originalUrl ?? request.url ?? '',
    });
    const type = header(request.headers['content-type']);
    if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type))
      throw new MemorySecurityError('forbidden');
  } catch (error) {
    throw sanitized(error);
  }
}

@Controller('v1/memory/operator/identities')
export class MemoryOperatorIdentityController {
  constructor(
    @Inject(MemoryOperatorIdentityService)
    private readonly identities: MemoryOperatorIdentityService,
  ) {}

  /** Only root bootstrap secret may provision a personal credential, not bearers. */
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async issue(@Req() request: LocalRequest, @Body() input: unknown) {
    assertRequest(request, this.identities);
    if (request.headers.authorization)
      throw toMemoryHttpException(new MemorySecurityError('forbidden'));
    try {
      return await this.identities.issue(
        header(request.headers['x-dev-hub-memory-operator-secret']),
        input,
      );
    } catch (error) {
      throw sanitized(error);
    }
  }

  /** Permanent root revocation, with no query-string secret or actor override. */
  @Post(':id/revoke')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async revoke(@Req() request: LocalRequest, @Param('id') id: string, @Body() input: unknown) {
    assertRequest(request, this.identities);
    if (request.headers.authorization)
      throw toMemoryHttpException(new MemorySecurityError('forbidden'));
    try {
      return await this.identities.revoke(
        header(request.headers['x-dev-hub-memory-operator-secret']),
        id,
        input,
      );
    } catch (error) {
      throw sanitized(error);
    }
  }

  /** Proves only credential possession; never upgrades or rewrites memory. */
  @Post('whoami')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async whoami(@Req() request: LocalRequest, @Body() input: unknown) {
    assertRequest(request, this.identities);
    if (request.headers['x-dev-hub-memory-operator-secret'])
      throw toMemoryHttpException(new MemorySecurityError('forbidden'));
    const authorization = header(request.headers.authorization);
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    try {
      return await this.identities.whoami(bearer, input);
    } catch (error) {
      throw sanitized(error);
    }
  }
}
