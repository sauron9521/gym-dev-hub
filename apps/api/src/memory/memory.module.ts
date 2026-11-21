import { Module } from '@nestjs/common';
import { MemoryController } from './memory.controller.js';
import { MemoryAuthorizationService } from '../security/memory-authorization.service.js';
import { MemoryOperatorCredentialService } from '../security/memory-operator-credential.service.js';
import { MemoryOperatorCredentialController } from '../security/memory-operator-credential.controller.js';

// Read routes remain disabled; operator-only credential lifecycle is opt-in.
@Module({
  controllers: [MemoryController, MemoryOperatorCredentialController],
  providers: [
    {
      provide: MemoryAuthorizationService,
      useFactory: () => new MemoryAuthorizationService(),
    },
    {
      provide: MemoryOperatorCredentialService,
      useFactory: (authorization: MemoryAuthorizationService) =>
        new MemoryOperatorCredentialService(authorization),
      inject: [MemoryAuthorizationService],
    },
  ],
  exports: [MemoryAuthorizationService],
})
export class MemoryModule {}
