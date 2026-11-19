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

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [AppController, GitHubController, WorkspaceController, CodexController],
  providers: [
    GitHubService,
    ReadinessService,
    WorkspaceService,
    CodexBridgeService,
    CodexChatService,
  ],
})
export class AppModule {}
