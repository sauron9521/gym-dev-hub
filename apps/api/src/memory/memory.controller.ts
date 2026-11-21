import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

/** Route names reserved; all memory reads fail closed until #39 principal auth. */
@Controller('v1/memory')
export class MemoryController {
  private disabled(): never {
    throw new ServiceUnavailableException(
      'Shared Agent Memory reads disabled until repository authentication is configured',
    );
  }

  @Get()
  list(): never {
    return this.disabled();
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
