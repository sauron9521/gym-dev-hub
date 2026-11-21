import { Module } from '@nestjs/common';
import { MemoryController } from './memory.controller.js';
import { MemoryAuthenticatedReadService } from './memory-authenticated-read.service.js';
import { MemoryAuthorizationService } from '../security/memory-authorization.service.js';
import { MemoryOperatorCredentialService } from '../security/memory-operator-credential.service.js';
import { MemoryOperatorCredentialController } from '../security/memory-operator-credential.controller.js';

// Read list is independently opt-in; detail/revisions and all writes remain disabled.
@Module({
  controllers: [MemoryController, MemoryOperatorCredentialController],
  providers: [
    {
      provide: MemoryAuthorizationService,
      useFactory: () => new MemoryAuthorizationService(),
    },
    {
      provide: MemoryAuthenticatedReadService,
      useFactory: (authorization: MemoryAuthorizationService) =>
        new MemoryAuthenticatedReadService(authorization),
      inject: [MemoryAuthorizationService],
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
