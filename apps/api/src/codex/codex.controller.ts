import { Controller, Get, Post } from '@nestjs/common';
import type { CodexConnectionStatus } from '@gym-dev-hub/contracts';
import { CodexBridgeService } from './codex-bridge.service.js';

@Controller('workspace/codex')
export class CodexController {
  constructor(private readonly codex: CodexBridgeService) {}

  @Get('status')
  status(): CodexConnectionStatus {
    return this.codex.status();
  }

  @Post('connect')
  connect(): Promise<CodexConnectionStatus> {
    return this.codex.connect();
  }
}
