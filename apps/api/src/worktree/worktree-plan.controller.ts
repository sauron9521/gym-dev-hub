import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import type { WorktreePlan, WorktreeInspection } from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreeAuthorizationService } from './worktree-authorization.service.js';
import { WorktreeInspectionService } from './worktree-inspection.service.js';
import type { WorktreeCreationGrant, WorktreeHydrationGrant } from '@gym-dev-hub/contracts';
import { WorktreeHydrationService } from './worktree-hydration.service.js';

@Controller('workspace/sessions/:sessionId/worktree-plans')
export class WorktreePlanController {
  constructor(
    private readonly plans: WorktreePlanService,
    private readonly authorization: WorktreeAuthorizationService,
    private readonly inspection: WorktreeInspectionService,
    private readonly hydration: WorktreeHydrationService,
  ) {}

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

  @Get(':planId/inspection')
  async inspect(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
  ): Promise<WorktreeInspection> {
    const plans = await this.plans.list(sessionId);
    const plan = plans.find((item) => item.id === planId);
    if (!plan) throw new NotFoundException('План worktree не знайдено.');
    return this.inspection.inspect(plan);
  }

  @Post(':planId/authorize')
  authorize(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreeCreationGrant> {
    return this.authorization.authorize(sessionId, planId, body);
  }

  @Post(':planId/create')
  createWorktree(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreePlan> {
    return this.authorization.create(sessionId, planId, body);
  }

  @Post(':planId/hydration-authorize')
  authorizeHydration(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreeHydrationGrant> {
    return this.hydration.authorize(sessionId, planId, body);
  }

  @Post(':planId/hydrate')
  hydrate(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreePlan> {
    return this.hydration.hydrate(sessionId, planId, body);
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
