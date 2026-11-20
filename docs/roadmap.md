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
10. **Worktree manifest & acknowledgement**: allowlisted local source/repository validation, immutable planned worktree paths, fingerprinted review, TTL and revocation, without Git mutations (PR #9).
11. **Metadata-only worktree creation**: explicit local operator secret, SHA-pinned single-use grant, safe Git worktree registration without checkout, state/audit recovery (PR #10).
12. **Worktree recovery and hydration preflight**: read-only Git metadata checks, tree safety scan, no auto cleanup and no checkout (PR #11).
13. **Gated raw Git blob hydration**: separate operator-secret grant, pinned blob read, exclusive bounded writes, durable progress and failure state (PR #13).
14. **Isolated execution**: post-hydration integrity verification, scoped worker mounts, and controlled agent command execution in separate safe PRs.
15. **PR lifecycle**: task-to-draft-PR workflow, local checks, CI feedback and review gate.
16. **Orchestration**: task dependencies, safe parallel scheduling, recovery and multi-repo support.

Deliver each milestone as small, reviewable pull requests. The owner performs every merge manually.
