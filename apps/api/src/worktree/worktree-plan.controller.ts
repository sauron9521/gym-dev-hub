import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import type { WorktreePlan, WorktreeInspection } from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreeAuthorizationService } from './worktree-authorization.service.js';
import { WorktreeInspectionService } from './worktree-inspection.service.js';
import type { WorktreeCreationGrant, WorktreeHydrationGrant } from '@gym-dev-hub/contracts';
import { WorktreeHydrationService } from './worktree-hydration.service.js';
import { WorktreeIntegrityService } from './worktree-integrity.service.js';
import type {
  WorktreeIntegrityReport,
  WorktreeMountGrant,
  WorktreeMountProbeResult,
} from '@gym-dev-hub/contracts';
import { WorktreeMountService } from './worktree-mount.service.js';
import { WorktreeCodeReadService } from './worktree-code-read.service.js';
import { WorktreePatchPreflightService } from './worktree-patch-preflight.service.js';
import { WorktreePatchApplyService } from './worktree-patch-apply.service.js';
import { WorktreePatchReviewService } from './worktree-patch-review.service.js';
import { WorktreeToolService } from './worktree-tool.service.js';
import { TaskRunnerPolicyService } from './task-runner-policy.service.js';
import { TaskExecutionGrantService } from './task-execution-grant.service.js';
import { TaskTypecheckService } from './task-typecheck.service.js';
import type {
  TaskRunnerPreview,
  TaskExecutionGrant,
  TaskExecutionGrantRevocation,
  TaskTypecheckRunResult,
  TaskTypecheckCancelResult,
} from '@gym-dev-hub/contracts';
import type { WorktreeToolGrant, WorktreeToolResult } from '@gym-dev-hub/contracts';
import type {
  WorktreeCodeReadGrant,
  WorktreeCodeReadResult,
  WorktreePatchPreflightResult,
  WorktreePatchApplyGrant,
  WorktreePatchApplyResult,
  WorktreePostApplyReview,
} from '@gym-dev-hub/contracts';

@Controller('workspace/sessions/:sessionId/worktree-plans')
export class WorktreePlanController {
  constructor(
    private readonly plans: WorktreePlanService,
    private readonly authorization: WorktreeAuthorizationService,
    private readonly inspection: WorktreeInspectionService,
    private readonly hydration: WorktreeHydrationService,
    private readonly integrity: WorktreeIntegrityService,
    private readonly mount: WorktreeMountService,
    private readonly codeRead: WorktreeCodeReadService,
    private readonly patchPreflight: WorktreePatchPreflightService,
    private readonly patchApply: WorktreePatchApplyService,
    private readonly patchReview: WorktreePatchReviewService,
    private readonly tools: WorktreeToolService,
    private readonly taskRunner: TaskRunnerPolicyService,
    private readonly taskGrants: TaskExecutionGrantService,
    private readonly taskTypecheck: TaskTypecheckService,
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

  @Get(':planId/integrity')
  verifyIntegrity(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
  ): Promise<WorktreeIntegrityReport> {
    return this.integrity.verify(sessionId, planId);
  }

  @Post(':planId/mount-authorize')
  mountAuthorize(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreeMountGrant> {
    return this.mount.authorize(sessionId, planId, body);
  }

  @Post(':planId/mount-probe')
  mountProbe(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreeMountProbeResult> {
    return this.mount.probe(sessionId, planId, body);
  }

  @Post(':planId/code-read-authorize')
  codeReadAuthorize(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreeCodeReadGrant> {
    return this.codeRead.authorize(sessionId, planId, body);
  }

  @Post(':planId/code-read')
  codeReadFile(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreeCodeReadResult> {
    return this.codeRead.read(sessionId, planId, body);
  }

  /** Rechecks Git and diff only. No write capability or grants issued. */
  @Post(':planId/patch-preflight')
  patchPreflightCheck(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreePatchPreflightResult> {
    return this.patchPreflight.preview(sessionId, planId, body);
  }

  /** Explicit single-file operator grant, disabled by default. */
  @Post(':planId/patch-apply-authorize')
  patchApplyAuthorize(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreePatchApplyGrant> {
    return this.patchApply.authorize(sessionId, planId, body);
  }

  /** Consume one approved grant and write only that pinned worktree file. */
  @Post(':planId/patch-apply')
  patchApplyFile(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreePatchApplyResult> {
    return this.patchApply.apply(sessionId, planId, body);
  }

  /** Read-only audit + actual working tree Git diff, no scripts or Git mutation. */
  @Post(':planId/patch-review')
  patchReviewOneFile(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreePostApplyReview> {
    return this.patchReview.review(sessionId, planId, body);
  }

  @Post(':planId/tool-authorize')
  toolAuthorize(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreeToolGrant> {
    return this.tools.authorize(sessionId, planId, body);
  }

  @Post(':planId/tool-execute')
  toolExecute(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<WorktreeToolResult> {
    return this.tools.execute(sessionId, planId, body);
  }

  @Post(':planId/task-preview')
  taskPreview(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<TaskRunnerPreview> {
    return this.taskRunner.preview(sessionId, planId, body);
  }

  /** Issues a disabled-by-default, 45-second grant. Does not run any task. */
  @Post(':planId/task-grant-authorize')
  taskGrantAuthorize(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<TaskExecutionGrant> {
    return this.taskGrants.authorize(sessionId, planId, body);
  }

  /** Revokes a single outstanding grant before any execution attempt. */
  @Post(':planId/task-grant-revoke')
  taskGrantRevoke(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<TaskExecutionGrantRevocation> {
    return this.taskGrants.revoke(sessionId, planId, body);
  }

  /** One explicit, operator-approved pinned API_TYPECHECK; disabled by default. */
  @Post(':planId/task-execute')
  taskExecute(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): Promise<TaskTypecheckRunResult> {
    return this.taskTypecheck.execute(sessionId, planId, body);
  }

  /** Cancellation requires the independently configured operator secret. */
  @Post(':planId/task-cancel')
  taskCancel(
    @Param('sessionId') sessionId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ): TaskTypecheckCancelResult {
    return this.taskTypecheck.cancel(sessionId, planId, body);
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
