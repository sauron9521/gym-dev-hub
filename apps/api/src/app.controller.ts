import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@gym-dev-hub/contracts';

@Controller('health')
export class AppController {
  @Get('live')
  getHealth(): HealthResponse {
    return { status: 'ok', service: 'gym-dev-hub-api' };
  }
}
