import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { AgentSession, WorkspaceOverview } from '@gym-dev-hub/contracts';
import { WorkspaceService } from './workspace.service.js';

@Controller('workspace/sessions')
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

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

  @Post(':id/messages')
  addMessage(@Param('id') id: string, @Body() input: unknown): Promise<AgentSession> {
    return this.workspace.addMessage(id, input);
  }
}
