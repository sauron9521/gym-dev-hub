import { Module } from '@nestjs/common';
import { MemoryController } from './memory.controller.js';

// MemoryQueryService is intentionally NOT a Nest provider until #39.
@Module({ controllers: [MemoryController] })
export class MemoryModule {}
