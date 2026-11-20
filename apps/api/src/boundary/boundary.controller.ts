import { Controller, Get, Post } from '@nestjs/common';
import type { ExecutionBoundaryStatus } from '@gym-dev-hub/contracts';
import { BoundaryService } from './boundary.service.js';

@Controller('workspace/boundary')
export class BoundaryController {
  constructor(private readonly boundary: BoundaryService) {}

  @Get('status')
  getStatus(): ExecutionBoundaryStatus {
    return this.boundary.status();
  }

  @Post('preflight')
  runPreflight(): Promise<ExecutionBoundaryStatus> {
    return this.boundary.runPreflight();
  }
}
