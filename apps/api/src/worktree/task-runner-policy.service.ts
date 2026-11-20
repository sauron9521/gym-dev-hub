import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type {
  TaskRunnerPreview,
  TaskRunnerRecipeId,
} from '@gym-dev-hub/contracts';
import { WorktreePlanService } from './worktree-plan.service.js';
import { WorktreeIntegrityService } from './worktree-integrity.service.js';

const REPOSITORY = 'sauron9521/gym-platform' as const;
const recipes = {
  API_TEST: { label: 'API — unit tests', package: '@gym/api', script: 'test' },
  API_TYPECHECK: { label: 'API — TypeScript', package: '@gym/api', script: 'typecheck' },
  API_LINT: { label: 'API — lint', package: '@gym/api', script: 'lint' },
  WEB_TEST: { label: 'Web — unit tests', package: '@gym/web', script: 'test' },
  WEB_TYPECHECK: { label: 'Web — TypeScript', package: '@gym/web', script: 'typecheck' },
  WEB_LINT: { label: 'Web — lint', package: '@gym/web', script: 'lint' },
} as const satisfies Record<
  TaskRunnerRecipeId,
  { label: string; package: string; script: string }
>;

const schema = z.strictObject({
  recipeId: z.enum([
    'API_TEST',
    'API_TYPECHECK',
    'API_LINT',
    'WEB_TEST',
    'WEB_TYPECHECK',
    'WEB_LINT',
  ]),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

@Injectable()
export class TaskRunnerPolicyService {
  constructor(
    private readonly plans: WorktreePlanService,
    private readonly integrity: WorktreeIntegrityService,
  ) {}

  /**
   * Policy preview ONLY. Never spawn a process, mount any folder, issue a
   * token, persist an execution intent or grant access to source code.
   */
  async preview(sessionId: string, planId: string, input: unknown): Promise<TaskRunnerPreview> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException('Невідомий рецепт перевірки або некоректний fingerprint.');
    }
    const plan = await this.plans.availableForMountProbe(sessionId, planId);
    if (
      plan.repository !== REPOSITORY ||
      plan.fingerprint !== parsed.data.fingerprint ||
      !plan.baseHeadSha ||
      !/^[0-9a-f]{40,64}$/.test(plan.baseHeadSha)
    ) {
      throw new ConflictException('План worktree або Git commit не відповідає рецепту.');
    }

    // Re-check live source integrity. Never trust an earlier browser snapshot.
    const report = await this.integrity.verify(sessionId, planId);
    if (
      report.status !== 'verified' ||
      report.mount.sourcePath !== plan.targetPath ||
      report.mount.mountEnabled ||
      report.mount.executionEnabled ||
      !report.mount.readOnly ||
      report.mount.networkEnabled
    ) {
      throw new ConflictException('Потрібна актуальна успішна перевірка Git worktree.');
    }
    const recipe = recipes[parsed.data.recipeId];
    return {
      sessionId,
      planId,
      repository: REPOSITORY,
      recipeId: parsed.data.recipeId,
      label: recipe.label,
      baseHeadSha: plan.baseHeadSha,
      fingerprint: plan.fingerprint,
      generatedAt: new Date().toISOString(),
      argv: ['pnpm', '--filter', recipe.package, recipe.script],
      workingDirectory: '/workspace',
      proposedBoundary: {
        network: 'none',
        sourceMount: 'read-only',
        writableArea: 'ephemeral-tmpfs',
        uid: 'non-root',
        dockerSocket: false,
        environmentSecrets: false,
        maxDurationSeconds: 600,
        maxMemoryMiB: 2048,
        maxCpus: 2,
        maxPids: 128,
        maxOutputBytes: 65536,
      },
      status: 'preview-only',
      executionEnabled: false,
      approvalGranted: false,
      runnerImageAvailable: false,
      executesUntrustedProjectScripts: true,
      notes: [
        'Це лише попередній перегляд. Жодного процесу або Docker контейнера не запущено.',
        'pnpm scripts виконують код репозиторію: перед реальним запуском потрібні ізольований runner image, залежності та окремий одноразовий дозвіл.',
        'Поточний однофайловий Docker worker не підтримує виконання тестів і не отримує нових дозволів.',
        'Git push, внесення змін до main та автоматичний merge заборонені.',
      ],
    };
  }
}
