import { Controller, Get, Post } from '@nestjs/common';
import type { IsolatedWorkerStatus } from '@gym-dev-hub/contracts';
import { WorkerService } from './worker.service.js';

@Controller('workspace/worker')
export class WorkerController {
  constructor(private readonly worker: WorkerService) {}

  @Get('status')
  status(): IsolatedWorkerStatus {
    return this.worker.status();
  }

  @Post('start')
  start(): Promise<IsolatedWorkerStatus> {
    return this.worker.start();
  }

  @Post('ping')
  ping(): Promise<IsolatedWorkerStatus> {
    return this.worker.ping();
  }

  @Post('stop')
  stop(): Promise<IsolatedWorkerStatus> {
    return this.worker.stop();
  }
}
