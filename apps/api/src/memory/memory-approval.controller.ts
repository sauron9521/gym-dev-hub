import type { IncomingMessage } from 'node:http';
import { Body, Controller, Header, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { MemoryApprovalService } from './memory-approval.service.js';
import { toMemoryHttpException } from '../security/memory-http-identity.js';
import { MemorySecurityError } from '../security/memory-security-policy.js';

type LocalRequest = IncomingMessage & { originalUrl?: string };
const onlyString = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

function requireOperatorRequest(request: LocalRequest, approvals: MemoryApprovalService) {
  try {
    approvals.assertLocalOperatorHttp({
      method: request.method ?? '',
      host: onlyString(request.headers.host),
      remoteAddress: request.socket.remoteAddress,
      origin: onlyString(request.headers.origin),
      fetchSite: onlyString(request.headers['sec-fetch-site']),
      path: request.originalUrl ?? request.url ?? '',
    });
    const contentType = onlyString(request.headers['content-type']);
    if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType))
      throw new MemorySecurityError('forbidden');
    // Never accept agent read/proposal bearers as alternative operator auth.
    if (request.headers.authorization) throw new MemorySecurityError('forbidden');
    return onlyString(request.headers['x-dev-hub-memory-operator-secret']);
  } catch (error) {
    throw toMemoryHttpException(error);
  }
}

/** Local operator manually inspects untrusted text+source before approving. */
@Controller('v1/memory/operator/approval-grants')
export class MemoryApprovalGrantController {
  constructor(
    @Inject(MemoryApprovalService)
    private readonly approvals: MemoryApprovalService,
  ) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async reviewAndGrant(@Req() request: LocalRequest, @Body() input: unknown) {
    try {
      return await this.approvals.reviewAndGrant(
        requireOperatorRequest(request, this.approvals),
        input,
      );
    } catch (error) {
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw error;
    }
  }
}

/** Second explicit operator POST consumes one-use intent and performs one CAS. */
@Controller('v1/memory')
export class MemoryApprovalController {
  constructor(
    @Inject(MemoryApprovalService)
    private readonly approvals: MemoryApprovalService,
  ) {}

  @Post(':id/reject')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async reject(@Req() request: LocalRequest, @Param('id') id: string, @Body() input: unknown) {
    try {
      const secret = requireOperatorRequest(request, this.approvals);
      return await this.approvals.reject(
        secret,
        onlyString(request.headers['x-dev-hub-memory-approval-grant']),
        id,
        input,
      );
    } catch (error) {
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw error;
    }
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async approve(@Req() request: LocalRequest, @Param('id') id: string, @Body() input: unknown) {
    try {
      const secret = requireOperatorRequest(request, this.approvals);
      return await this.approvals.approve(
        secret,
        onlyString(request.headers['x-dev-hub-memory-approval-grant']),
        id,
        input,
      );
    } catch (error) {
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw error;
    }
  }
}

/** Rejection grants are distinct from approval grants and cannot be exchanged. */
@Controller('v1/memory/operator/rejection-grants')
export class MemoryRejectionGrantController {
  constructor(
    @Inject(MemoryApprovalService)
    private readonly approvals: MemoryApprovalService,
  ) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async reviewAndGrant(@Req() request: LocalRequest, @Body() input: unknown) {
    try {
      return await this.approvals.reviewRejectionAndGrant(
        requireOperatorRequest(request, this.approvals),
        input,
      );
    } catch (error) {
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw error;
    }
  }
}
