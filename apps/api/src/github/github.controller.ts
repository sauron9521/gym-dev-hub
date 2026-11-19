import { Controller, Get, Query } from '@nestjs/common';
import type { GitHubDashboard } from '@gym-dev-hub/contracts';
import { GitHubService } from './github.service.js';
import { ReadinessService } from './readiness.service.js';
import type { PullReadiness } from '@gym-dev-hub/contracts';

@Controller('github')
export class GitHubController {
  constructor(
    private readonly github: GitHubService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get('dashboard')
  getDashboard(@Query('repository') repository?: string): Promise<GitHubDashboard> {
    return this.github.getDashboard(repository);
  }

  @Get('readiness')
  getReadiness(
    @Query('repository') repository: string | undefined,
    @Query('number') number: string | undefined,
  ): Promise<PullReadiness> {
    return this.readiness.getReadiness(repository, number);
  }
}
