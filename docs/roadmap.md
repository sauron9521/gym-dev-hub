# Development milestones

1. **Bootstrap**: pnpm/Turborepo, Next.js, NestJS, shared packages and CI (PR #1, merged).
2. **Repository dashboard**: GitHub read-only PR/Issue/Milestone/Actions views, per-repository switching, explicit partial failures (PR #2).
3. **PR checks drill-down**: current head-SHA check runs, legacy commit statuses, classic required checks, conservative review readiness, short-lived cache (PR #3).
4. **GitHub data reliability**: GitHub Rulesets, review approvals, full required-check evaluation, pagination, rate-limit improvements and optional read-only GitHub App installation, in small follow-up PRs.
5. **Agent workspace foundation**: local persistent sessions, parallel tabs, task states and notes (PR #4).
6. **Codex adapter foundation**: optional local app-server handshake, persisted read-only thread bindings and connection health (PR #5).
7. **Agent Chat (read-only)**: streamed Codex text turns over SSE, local chat history and failure handling (PR #6).
8. **Execution boundary preflight**: local Linux Docker status, pinned test image, read-only/no-network/no-mounts probe, fail-closed capabilities (PR #7).
9. **Isolated worker foundation**: locally built dedicated worker image, fixed HELLO/PING/SHUTDOWN protocol, lifecycle and fail-closed Docker policies (PR #8).
10. **Isolated execution**: explicit approvals, per-task Git worktrees and controlled command execution in separate safe PRs.
11. **PR lifecycle**: task-to-draft-PR workflow, local checks, CI feedback and review gate.
12. **Orchestration**: task dependencies, safe parallel scheduling, recovery and multi-repo support.

Deliver each milestone as small, reviewable pull requests. The owner performs every merge manually.
