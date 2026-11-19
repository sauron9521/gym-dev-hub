import { Controller, Get, Query } from '@nestjs/common';
import type { GitHubDashboard } from '@gym-dev-hub/contracts';
import { GitHubService } from './github.service.js';

@Controller('github')
export class GitHubController {
  constructor(private readonly github: GitHubService) {}

  @Get('dashboard')
  getDashboard(@Query('repository') repository?: string): Promise<GitHubDashboard> {
    return this.github.getDashboard(repository);
  }
}
