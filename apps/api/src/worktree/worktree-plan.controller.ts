import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { WorktreePlan } from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';

@Controller('workspace/sessions/:sessionId/worktree-plans')
export class WorktreePlanController {
  constructor(private readonly plans: WorktreePlanService) {}

  @Get()
  list(@Param('sessionId') sessionId: string): Promise<WorktreePlan[]> {
    return this.plans.list(sessionId);
  }

  @Post()
  create(@Param('sessionId') sessionId: string): Promise<WorktreePlan> {
    return this.plans.create(sessionId);
  }

  @Post(':planId/acknowledge')
  acknowledge(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreePlan> {
    return this.plans.acknowledge(sessionId, planId, body);
  }

  @Post(':planId/revoke')
  revoke(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreePlan> {
    return this.plans.revoke(sessionId, planId, body);
  }
}
