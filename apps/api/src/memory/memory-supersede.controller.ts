import type { IncomingMessage } from 'node:http';
import { Body, Controller, Header, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { MemoryApprovalService } from './memory-approval.service.js';
import { requireOperatorRequest } from './memory-approval.controller.js';
import { MemorySupersedeService } from './memory-supersede.service.js';
import { toMemoryHttpException } from '../security/memory-http-identity.js';
import { MemorySecurityError } from '../security/memory-security-policy.js';

type LocalRequest = IncomingMessage & { originalUrl?: string };
const grantHeader = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

/** The operator must review BOTH untrusted source-linked records first. */
@Controller('v1/memory/operator/supersede-grants')
export class MemorySupersedeGrantController {
  constructor(
    @Inject(MemorySupersedeService) private readonly service: MemorySupersedeService,
    @Inject(MemoryApprovalService) private readonly boundary: MemoryApprovalService,
  ) {}
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async review(@Req() request: LocalRequest, @Body() input: unknown) {
    try {
      return await this.service.reviewAndGrant(
        requireOperatorRequest(request, this.boundary),
        input,
      );
    } catch (error) {
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw error;
    }
  }
}

@Controller('v1/memory')
export class MemorySupersedeController {
  constructor(
    @Inject(MemorySupersedeService) private readonly service: MemorySupersedeService,
    @Inject(MemoryApprovalService) private readonly boundary: MemoryApprovalService,
  ) {}
  @Post(':id/supersede')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async supersede(@Req() request: LocalRequest, @Param('id') id: string, @Body() input: unknown) {
    try {
      return await this.service.supersede(
        requireOperatorRequest(request, this.boundary),
        grantHeader(request.headers['x-dev-hub-memory-approval-grant']),
        id,
        input,
      );
    } catch (error) {
      if (error instanceof MemorySecurityError) throw toMemoryHttpException(error);
      throw error;
    }
  }
}
