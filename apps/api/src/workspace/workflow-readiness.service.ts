/**
 * No-write, no-auth-token-disclosure readiness for a deliberate disposable
 * end-to-end smoke. This does NOT prove Docker execution or GitHub permissions.
 */
import { Injectable } from '@nestjs/common';
import type {
  WorkflowReadinessGate,
  WorkflowReadinessReport,
  WorkflowGateId,
} from '@gym-dev-hub/contracts';
import { resolve } from 'node:path';
import { GitHubService } from '../github/github.service.js';
import { WorktreeGitService } from '../worktree/worktree-git.service.js';
import { configuredCommitIdentity } from '../worktree/worktree-fixed-commit.js';
import { readPublicGitHubMainSha } from './workflow-public-main-ref.js';

type SafeEnvironment = Readonly<Record<string, string | undefined>>;
const SHA = /^[a-f0-9]{40}$/;
const REPO = 'sauron9521/gym-dev-hub' as const;

interface GateRequirements {
  id: Exclude<WorkflowGateId, 'source' | 'ci'>;
  title: string;
  flags: string[];
  operatorSecrets?: string[];
  tokens?: string[];
  author?: boolean;
  note: string;
}
const gates: readonly GateRequirements[] = [
  {
    id: 'worktree',
    title: 'Створення worktree',
    flags: ['DEV_HUB_ENABLE_WORKTREE_CREATION'],
    operatorSecrets: ['DEV_HUB_WORKTREE_OPERATOR_SECRET'],
    note: 'Тільки окрема devhub/task-* гілка з дозволом оператора',
  },
  {
    id: 'hydration',
    title: 'Наповнення worktree',
    flags: ['DEV_HUB_ENABLE_WORKTREE_CREATION', 'DEV_HUB_ENABLE_WORKTREE_HYDRATION'],
    operatorSecrets: ['DEV_HUB_WORKTREE_OPERATOR_SECRET'],
    note: 'Тільки перевірені Git blobs із зафіксованого коміту',
  },
  {
    id: 'scoped-read',
    title: 'Контрольоване читання коду',
    flags: ['DEV_HUB_ENABLE_WORKTREE_MOUNT', 'DEV_HUB_ENABLE_SCOPED_CODE_READ'],
    operatorSecrets: ['DEV_HUB_WORKTREE_OPERATOR_SECRET'],
    note: 'Потребує окремої перевірки Docker isolation перед запуском',
  },
  {
    id: 'patch-review',
    title: 'Патч та Git review',
    flags: [
      'DEV_HUB_ENABLE_WORKTREE_MOUNT',
      'DEV_HUB_ENABLE_SCOPED_CODE_READ',
      'DEV_HUB_ENABLE_PATCH_PREFLIGHT',
      'DEV_HUB_ENABLE_PATCH_APPLY',
      'DEV_HUB_ENABLE_PATCH_REVIEW',
    ],
    operatorSecrets: ['DEV_HUB_WORKTREE_OPERATOR_SECRET', 'DEV_HUB_PATCH_APPLY_OPERATOR_SECRET'],
    note: 'Один схвалений файл; повторна перевірка фактичного diff',
  },
  {
    id: 'docker-check',
    title: 'Фіксовані Docker-перевірки',
    flags: ['DEV_HUB_ENABLE_PATCH_CHECKS'],
    operatorSecrets: ['DEV_HUB_PATCH_CHECK_OPERATOR_SECRET'],
    note: 'Конфігурація не доводить запуск контейнера чи успіх тестів',
  },
  {
    id: 'candidate',
    title: 'Перегляд Git commit candidate',
    flags: ['DEV_HUB_ENABLE_COMMIT_CANDIDATE_PREVIEW', 'DEV_HUB_ENABLE_PATCH_REVIEW'],
    operatorSecrets: [
      'DEV_HUB_COMMIT_CANDIDATE_OPERATOR_SECRET',
      'DEV_HUB_PATCH_APPLY_OPERATOR_SECRET',
    ],
    note: 'Попередній перегляд, а не дозвіл на commit',
  },
  {
    id: 'local-commit',
    title: 'Локальний Git commit',
    flags: ['DEV_HUB_ENABLE_GIT_COMMIT'],
    operatorSecrets: ['DEV_HUB_GIT_COMMIT_OPERATOR_SECRET'],
    author: true,
    note: 'Одноразовий дозвіл, окрема task-гілка, без push',
  },
  {
    id: 'github-publish',
    title: 'Публікація GitHub task-гілки',
    flags: ['DEV_HUB_ENABLE_GITHUB_PUBLISH'],
    operatorSecrets: ['DEV_HUB_GITHUB_PUBLISH_OPERATOR_SECRET'],
    tokens: ['DEV_HUB_GITHUB_PUBLISH_TOKEN'],
    note: 'Потрібні реальні GitHub Contents:write права; тут вони не перевіряються',
  },
  {
    id: 'draft-pr',
    title: 'Створення Draft PR',
    flags: ['DEV_HUB_ENABLE_DRAFT_PR'],
    operatorSecrets: ['DEV_HUB_DRAFT_PR_OPERATOR_SECRET'],
    tokens: ['DEV_HUB_DRAFT_PR_TOKEN'],
    note: 'Потрібні Pull requests:write та Contents:read; merge не надається',
  },
] as const;

/**
 * Pure preflight of environment key shapes. Does not log or return any value
 * or count of bytes of a secret/token, and does not claim grants succeeded.
 */
export function evaluateWorkflowEnvironment(
  env: SafeEnvironment,
  authorValid: boolean,
): WorkflowReadinessGate[] {
  return gates.map((definition) => {
    const missingKeys: string[] = [];
    for (const flag of definition.flags) {
      if (env[flag] !== 'true') missingKeys.push(flag);
    }
    for (const secret of definition.operatorSecrets ?? []) {
      const value = env[secret];
      if (!value || Buffer.byteLength(value) < 32 || Buffer.byteLength(value) > 256) {
        missingKeys.push(secret);
      }
    }
    for (const token of definition.tokens ?? []) {
      const value = env[token];
      if (
        !value ||
        value.length < 32 ||
        value.length > 1024 ||
        value.trim() !== value ||
        /[\s\r\n]/.test(value)
      ) {
        missingKeys.push(token);
      }
    }
    if (definition.author && !authorValid) {
      missingKeys.push('DEV_HUB_COMMIT_AUTHOR_NAME', 'DEV_HUB_COMMIT_AUTHOR_EMAIL');
    }
    return {
      id: definition.id,
      title: definition.title,
      state: missingKeys.length ? 'blocked' : 'configured',
      missingKeys: [...new Set(missingKeys)],
      note: definition.note,
    };
  });
}

@Injectable()
export class WorkflowReadinessService {
  constructor(
    private readonly github: GitHubService,
    private readonly git: WorktreeGitService,
  ) {}

  /** Public ref fallback only; available for hermetic regression stubs. */
  async readPublicMainHead(): Promise<string | null> {
    return readPublicGitHubMainSha();
  }

  async report(): Promise<WorkflowReadinessReport> {
    let authorValid = false;
    try {
      configuredCommitIdentity();
      authorValid = true;
    } catch {
      /* No output from credentials or validation errors. */
    }
    const checks = evaluateWorkflowEnvironment(process.env, authorValid);
    const reposRoot = resolve(
      process.env.DEV_HUB_REPOS_ROOT ?? resolve(process.cwd(), '..', '..', '..'),
    );
    const [local, github] = await Promise.allSettled([
      this.git.headSha({
        repository: REPO,
        sourcePath: resolve(reposRoot, 'gym-dev-hub'),
      }),
      this.github.request<{ object?: { sha?: string } }>(
        '/repos/sauron9521/gym-dev-hub/git/ref/heads/main',
      ),
    ]);
    const localHeadSha = local.status === 'fulfilled' && SHA.test(local.value) ? local.value : null;
    const received = github.status === 'fulfilled' ? github.value.object?.sha : undefined;
    const apiMainSha = received && SHA.test(received) ? received : null;
    // A public Git ref can establish source freshness when anonymous REST is
    // rate-limited, but cannot establish API reachability or actual CI status.
    const gitMain = apiMainSha ? null : await this.readPublicMainHead();
    const githubMainSha = apiMainSha ?? (gitMain && SHA.test(gitMain) ? gitMain : null);
    const sourceState = !localHeadSha
      ? 'blocked'
      : !githubMainSha
        ? 'unknown'
        : localHeadSha === githubMainSha
          ? 'configured'
          : 'blocked';
    const sourceNote = !localHeadSha
      ? 'Локальну основну копію Git не вдалося підтвердити'
      : !githubMainSha
        ? 'GitHub main недоступний — актуальність локального коду невідома'
        : sourceState === 'configured'
          ? apiMainSha
            ? 'Локальний HEAD збігається з поточним GitHub main'
            : 'Локальний HEAD збігається з публічним Git main (read-only); GitHub REST/CI недоступний'
          : 'Локальний HEAD відстає або відрізняється від GitHub main; не змінюй локальні файли автоматично';
    const all: WorkflowReadinessGate[] = [
      {
        id: 'source',
        title: 'Актуальний Git main',
        state: sourceState,
        missingKeys: [],
        note: sourceNote,
      },
      ...checks,
      {
        id: 'ci',
        title: 'GitHub CI readiness',
        state: apiMainSha ? 'configured' : 'unknown',
        missingKeys: [],
        note: apiMainSha
          ? 'Read-only CI доступний після Draft PR; успіх checks тут не підтверджено'
          : 'GitHub REST API недоступний; public git main не підтверджує CI. Перевір API-доступ окремо',
      },
    ];
    return {
      repository: REPO,
      checkedAt: new Date().toISOString(),
      source: { localHeadSha, githubMainSha, state: sourceState },
      gates: all,
      configuredCount: all.filter((g) => g.state === 'configured').length,
      totalCount: all.length,
      preconditionsSatisfied: all.every((g) => g.state === 'configured'),
      readOnly: true,
      mutatingCommandsExecuted: false,
      writesPerformed: false,
      githubPermissionsVerified: false,
      dockerExecutionVerified: false,
      endToEndVerified: false,
    };
  }
}
