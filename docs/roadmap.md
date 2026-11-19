# Development milestones

1. **Bootstrap**: pnpm/Turborepo, Next.js, NestJS, shared packages and CI (PR #1, merged).
2. **Repository dashboard**: GitHub read-only PR/Issue/Milestone/Actions views, per-repository switching, explicit partial failures (PR #2).
3. **GitHub data reliability**: authoritative PR check-runs, pagination, caching/rate-limit strategy and optional GitHub App read-only installation, in small follow-up PRs.
4. **Agent workspace**: session lifecycle, chat UI, Codex app-server integration and per-task worktrees.
5. **PR lifecycle**: task-to-draft-PR workflow, local checks, CI feedback and review gate.
6. **Orchestration**: task dependencies, safe parallel scheduling, recovery and multi-repo support.

Deliver each milestone as small, reviewable pull requests. The owner performs every merge manually.
