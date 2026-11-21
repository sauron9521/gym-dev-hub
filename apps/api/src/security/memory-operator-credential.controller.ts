import type { IncomingMessage } from 'node:http';
import {
  Body,
  Controller,
  Delete,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { MemoryOperatorCredentialService } from './memory-operator-credential.service.js';
import { toMemoryHttpException } from './memory-http-identity.js';
import { MemorySecurityError } from './memory-security-policy.js';

type LocalRequest = IncomingMessage & { originalUrl?: string };
const onlyString = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

@Controller('v1/memory/operator/credentials')
export class MemoryOperatorCredentialController {
  constructor(
    @Inject(MemoryOperatorCredentialService)
    private readonly credentials: MemoryOperatorCredentialService,
  ) {}

  private authorizeLocalOperatorRequest(request: LocalRequest): string | undefined {
    // Parse server-side socket and original URL, never x-forwarded-* or client-supplied actor.
    this.credentials.assertLocalOperatorHttp({
      method: request.method ?? '',
      host: onlyString(request.headers.host),
      remoteAddress: request.socket.remoteAddress,
      origin: onlyString(request.headers.origin),
      fetchSite: onlyString(request.headers['sec-fetch-site']),
      path: request.originalUrl ?? request.url ?? '',
    });
    return onlyString(request.headers['x-dev-hub-memory-operator-secret']);
  }

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async issue(@Req() request: LocalRequest, @Body() input: unknown) {
    try {
      const contentType = onlyString(request.headers['content-type']);
      if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType))
        throw new MemorySecurityError('forbidden');
      const secret = this.authorizeLocalOperatorRequest(request);
      return await this.credentials.issue(secret, input);
    } catch (error) {
      throw toMemoryHttpException(error);
    }
  }

  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  revoke(@Req() request: LocalRequest, @Param('id') credentialId: string) {
    try {
      const secret = this.authorizeLocalOperatorRequest(request);
      return this.credentials.revoke(secret, credentialId);
    } catch (error) {
      throw toMemoryHttpException(error);
    }
  }
}
