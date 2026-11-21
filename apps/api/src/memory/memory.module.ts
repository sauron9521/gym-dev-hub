import { Module } from '@nestjs/common';
import { MemoryController } from './memory.controller.js';
import { MemoryProposalController } from './memory-proposal.controller.js';
import { MemoryProposalService } from './memory-proposal.service.js';
import { MemoryApprovalService } from './memory-approval.service.js';
import {
  MemoryApprovalController,
  MemoryApprovalGrantController,
  MemoryRejectionGrantController,
} from './memory-approval.controller.js';
import { MemoryAuthenticatedReadService } from './memory-authenticated-read.service.js';
import { MemoryAuthorizationService } from '../security/memory-authorization.service.js';
import { MemoryOperatorCredentialService } from '../security/memory-operator-credential.service.js';
import { MemoryOperatorCredentialController } from '../security/memory-operator-credential.controller.js';

// Verified reads, agent proposals and operator-only CAS approval each require separate opt-in.
@Module({
  controllers: [
    MemoryController,
    MemoryOperatorCredentialController,
    MemoryProposalController,
    MemoryApprovalGrantController,
    MemoryRejectionGrantController,
    MemoryApprovalController,
  ],
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
      provide: MemoryApprovalService,
      useFactory: (authorization: MemoryAuthorizationService) =>
        new MemoryApprovalService(authorization),
      inject: [MemoryAuthorizationService],
    },
    {
      provide: MemoryProposalService,
      useFactory: (authorization: MemoryAuthorizationService) =>
        new MemoryProposalService(authorization),
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
