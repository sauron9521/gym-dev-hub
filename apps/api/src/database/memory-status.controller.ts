import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

/** Deliberately inert until #39 authenticated repository scopes and #40 writes. */
@Controller('v1/memory')
export class MemoryStatusController {
  @Get('status')
  status(): never {
    throw new ServiceUnavailableException(
      'Shared Agent Memory API is disabled pending authenticated rollout',
    );
  }
}
