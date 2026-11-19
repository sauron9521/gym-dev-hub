import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { AgentSession, WorkspaceOverview } from '@gym-dev-hub/contracts';
import { WorkspaceService } from './workspace.service.js';
import { CodexChatService } from '../codex/codex-chat.service.js';
import { Sse } from '@nestjs/common';
import type { ChatSnapshot, ChatStreamEvent } from '@gym-dev-hub/contracts';
import type { Observable } from 'rxjs';

@Controller('workspace/sessions')
export class WorkspaceController {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly chat: CodexChatService,
  ) {}

  @Get()
  list(): Promise<WorkspaceOverview> {
    return this.workspace.list();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<AgentSession> {
    return this.workspace.get(id);
  }

  @Post()
  create(@Body() input: unknown): Promise<AgentSession> {
    return this.workspace.create(input);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() input: unknown): Promise<AgentSession> {
    return this.workspace.update(id, input);
  }

  @Post(':id/codex')
  attachCodex(
    @Param('id') id: string,
  ): Promise<import('@gym-dev-hub/contracts').CodexSessionBinding> {
    return this.workspace.linkCodex(id);
  }

  @Get(':id/chat')
  getChat(@Param('id') id: string): Promise<ChatSnapshot> {
    return this.chat.snapshot(id);
  }

  @Post(':id/chat')
  sendPrompt(@Param('id') id: string, @Body() input: unknown): Promise<ChatSnapshot> {
    return this.chat.start(id, input);
  }

  @Sse(':id/chat/events')
  chatEvents(@Param('id') id: string): Observable<{ data: ChatStreamEvent }> {
    return this.chat.events(id);
  }

  @Post(':id/messages')
  addMessage(@Param('id') id: string, @Body() input: unknown): Promise<AgentSession> {
    return this.workspace.addMessage(id, input);
  }
}
