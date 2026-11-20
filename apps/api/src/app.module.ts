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
  ],
})
export class AppModule {}
