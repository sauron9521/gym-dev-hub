import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { GitHubController } from './github/github.controller.js';
import { GitHubService } from './github/github.service.js';
import { ReadinessService } from './github/readiness.service.js';
import { WorkspaceController } from './workspace/workspace.controller.js';
import { WorkspaceService } from './workspace/workspace.service.js';
import { CodexBridgeService } from './codex/codex-bridge.service.js';
import { CodexController } from './codex/codex.controller.js';
import { CodexChatService } from './codex/codex-chat.service.js';
import { BoundaryController } from './boundary/boundary.controller.js';
import { BoundaryService } from './boundary/boundary.service.js';
import { WorkerController } from './worker/worker.controller.js';
import { WorkerService } from './worker/worker.service.js';
import { WorktreePlanService } from './worktree/worktree-plan.service.js';
import { WorktreePlanController } from './worktree/worktree-plan.controller.js';
import { WorktreeGitService } from './worktree/worktree-git.service.js';
import { WorktreeAuthorizationService } from './worktree/worktree-authorization.service.js';
import { WorktreeInspectionService } from './worktree/worktree-inspection.service.js';
import { WorktreeHydrationService } from './worktree/worktree-hydration.service.js';
import { WorktreeIntegrityService } from './worktree/worktree-integrity.service.js';
import { WorktreeMountService } from './worktree/worktree-mount.service.js';
import { WorktreeCodeReadService } from './worktree/worktree-code-read.service.js';
import { WorktreePatchPreflightService } from './worktree/worktree-patch-preflight.service.js';
import { WorktreePatchApplyService } from './worktree/worktree-patch-apply.service.js';
import { WorktreeToolService } from './worktree/worktree-tool.service.js';
import { TaskRunnerPolicyService } from './worktree/task-runner-policy.service.js';
import { TaskExecutionGrantService } from './worktree/task-execution-grant.service.js';
import { TaskTypecheckService } from './worktree/task-typecheck.service.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [
    AppController,
    GitHubController,
    WorkspaceController,
    CodexController,
    BoundaryController,
    WorkerController,
    WorktreePlanController,
  ],
  providers: [
    GitHubService,
    ReadinessService,
    WorkspaceService,
    CodexBridgeService,
    CodexChatService,
    BoundaryService,
    WorkerService,
    WorktreePlanService,
    WorktreeGitService,
    WorktreeAuthorizationService,
    WorktreeInspectionService,
    WorktreeHydrationService,
    WorktreeIntegrityService,
    WorktreeMountService,
    WorktreeCodeReadService,
    WorktreePatchPreflightService,
    WorktreePatchApplyService,
    WorktreeToolService,
    TaskRunnerPolicyService,
    TaskExecutionGrantService,
    TaskTypecheckService,
  ],
})
export class AppModule {}
