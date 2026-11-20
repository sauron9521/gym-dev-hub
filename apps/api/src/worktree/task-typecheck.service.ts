import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import type { TaskTypecheckRunResult, TaskTypecheckCancelResult } from '@gym-dev-hub/contracts';
import { BoundaryService } from '../boundary/boundary.service.js';
import { TaskExecutionGrantService } from './task-execution-grant.service.js';
import { prepareTypecheckRunner, runPinnedTypecheckDocker } from './task-typecheck-docker.js';

const SOURCE_COMMIT = '7104f723c4ee7b81e7b9b64e9c9483aea344ef7a';
const SOURCE_TREE = '2c140e1e740b3dd8cc7582db726f46b54b73b334';
const MANIFEST_SHA = 'dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b';

const runSchema = z.strictObject({
  runId: z.uuid(),
  grantToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  recipeId: z.literal('API_TYPECHECK'),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceCommit: z.literal(SOURCE_COMMIT),
  sourceTree: z.literal(SOURCE_TREE),
  sourceManifestSha256: z.literal(MANIFEST_SHA),
});
const cancelSchema = z.strictObject({
  runId: z.uuid(),
  operatorSecret: z.string().min(32).max(256),
});

type ActiveRun = {
  runId: string;
  sessionId: string;
  planId: string;
  abort: AbortController;
};

/** Opt-in single-flight local operator execution, never an agent-controlled shell. */
@Injectable()
export class TaskTypecheckService {
  private active: ActiveRun | null = null;

  constructor(
    private readonly grants: TaskExecutionGrantService,
    private readonly boundary: BoundaryService,
  ) {}

  private enabled(): void {
    if (process.env.DEV_HUB_ENABLE_TASK_EXECUTION !== 'true') {
      throw new ServiceUnavailableException('Локальне виконання задач вимкнене.');
    }
  }

  private freshBoundary(): void {
    const status = this.boundary.status();
    const age = status.checkedAt
      ? Date.now() - Date.parse(status.checkedAt)
      : Number.POSITIVE_INFINITY;
    if (status.state !== 'passed' || !Number.isFinite(age) || age < 0 || age > 300_000) {
      throw new ConflictException('Потрібен свіжий успішний Docker Safety Preflight.');
    }
  }

  async execute(
    sessionId: string,
    planId: string,
    input: unknown,
  ): Promise<TaskTypecheckRunResult> {
    const request = runSchema.safeParse(input);
    if (!request.success) throw new BadRequestException('Недозволений запуск задачі.');
    this.enabled();
    if (this.active) throw new ConflictException('Інша Docker-задача вже виконується.');
    const current: ActiveRun = {
      runId: request.data.runId,
      sessionId,
      planId,
      abort: new AbortController(),
    };
    // Set before any await, avoiding concurrent execution even during preflight.
    this.active = current;
    const startedAt = Date.now();
    try {
      this.freshBoundary();
      // Fail closed on missing image/source/cache/engine without consuming a grant.
      const prepared = await prepareTypecheckRunner();
      if (current.abort.signal.aborted) throw new ConflictException('Запуск скасований.');
      this.enabled();
      this.freshBoundary();
      const approved = await this.grants.consumeForExecution(sessionId, planId, {
        grantToken: request.data.grantToken,
        recipeId: request.data.recipeId,
        fingerprint: request.data.fingerprint,
        sourceCommit: request.data.sourceCommit,
        sourceManifestSha256: request.data.sourceManifestSha256,
      });
      if (current.abort.signal.aborted) throw new ConflictException('Запуск скасований.');
      this.enabled();
      const result = await runPinnedTypecheckDocker(prepared, current.abort.signal);
      if (current.abort.signal.aborted) throw new ConflictException('Запуск скасований.');
      return {
        runId: current.runId,
        grantId: approved.grantId,
        recipeId: 'API_TYPECHECK',
        sourceCommit: SOURCE_COMMIT,
        status: 'succeeded',
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        containerRemoved: result.containerRemoved,
        readOnlySource: true,
        networkEnabled: false,
        arbitraryCommandsEnabled: false,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        'Ізольований API_TYPECHECK відхилений або не завершився. Перевір образ, pinned store та Docker.',
      );
    } finally {
      this.active = null;
    }
  }

  cancel(sessionId: string, planId: string, input: unknown): TaskTypecheckCancelResult {
    const parsed = cancelSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некоректний запит скасування.');
    this.enabled();
    this.grants.authenticateForCancellation(parsed.data.operatorSecret);
    const current = this.active;
    if (
      !current ||
      current.runId !== parsed.data.runId ||
      current.sessionId !== sessionId ||
      current.planId !== planId
    ) {
      throw new ConflictException('Немає активного запуску з таким ідентифікатором.');
    }
    current.abort.abort();
    return { runId: current.runId, status: 'cancel-requested' };
  }
}
