# Architecture (initial design)

This repository owns the orchestration tooling. Target repositories (including `gym-platform`) remain unaware of it.

- `apps/web`: Next.js 16 workspace interface (localhost:3100)
- `apps/api`: NestJS 12 orchestration API (localhost:3101, loopback-only by default)
- `packages/contracts`: shared types and DTO contracts
- `packages/tsconfig`: shared compiler settings
- Read-only GitHub REST integration: implemented for allowlisted repositories via NestJS, with an optional server-side read-only token
- GitHub App installation and write permissions: planned as separate permission-gated work
- Agent Workspace foundation: local versioned JSON store (one NestJS process), repository-bound tasks, notes and UI tabs
- Codex app-server connection and read-only per-session thread bindings: implemented; no turns, commands, Git writes or approval grants (PR #5)
- Read-only text chat via Codex app-server, streaming SSE and local chat history: implemented in PR #6
- Docker execution isolation preflight: fixed diagnostic container with pinned image, no network or host mounts, non-root, read-only root and strict limits (PR #7)
- Dedicated Codex worker isolation, approval UI and Git worktrees: planned as separate, permission-gated slices
- Persistence and worker queues: planned, separate from target repositories

## Invariants

1. No direct writes to `main`, no automatic merge.
2. Every coding task has a unique branch / worktree and PR.
3. CI status is valid only for the current PR head commit SHA.
4. Parallel work must coordinate shared files, lockfiles and migrations.
5. Never expose host terminals, Docker sockets or write APIs to untrusted networks.
6. Public code and CI must contain no credentials.
