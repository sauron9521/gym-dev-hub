# Development milestones

1. **Bootstrap**: pnpm/Turborepo, Next.js, NestJS, shared packages and CI (PR #1, merged).
2. **Repository dashboard**: GitHub read-only PR/Issue/Milestone/Actions views, per-repository switching, explicit partial failures (PR #2).
3. **PR checks drill-down**: current head-SHA check runs, legacy commit statuses, classic required checks, conservative review readiness, short-lived cache (PR #3).
4. **GitHub data reliability**: GitHub Rulesets, review approvals, full required-check evaluation, pagination, rate-limit improvements and optional read-only GitHub App installation, in small follow-up PRs.
5. **Agent workspace**: session lifecycle, chat UI, Codex app-server integration and per-task worktrees.
6. **PR lifecycle**: task-to-draft-PR workflow, local checks, CI feedback and review gate.
7. **Orchestration**: task dependencies, safe parallel scheduling, recovery and multi-repo support.

Deliver each milestone as small, reviewable pull requests. The owner performs every merge manually.
