# Gym Dev Hub

AI-assisted development orchestration workspace. This is an **independent public repository**; it does not require modifications to `gym-platform`.

## Prerequisites

- Node.js 24+
- pnpm 12.18.0

## Local development

```bash
pnpm install --frozen-lockfile
pnpm dev
```

- Dashboard: http://127.0.0.1:3100
- API: http://127.0.0.1:3101/health/live
- GitHub read-only data: http://127.0.0.1:3101/github/dashboard

The dashboard reads `sauron9521/gym-dev-hub` and `sauron9521/gym-platform` from the GitHub public API by default. For additional repository access and rate limits, copy `apps/api/.env.example` to `apps/api/.env` and configure an optional read-only GitHub token. Never commit tokens.

See [GitHub Dashboard and PR Checks setup](docs/github-dashboard.md) for the per-PR `/pr/[number]` verification page, capabilities, and limitations.

### Agent Workspace (local foundation)

Open <http://127.0.0.1:3100/workspace> to create separate implementation-task sessions, open multiple tabs, update task statuses, and save local notes. The Agent Chat interface now supports opt-in **real read-only Codex text turns with SSE streaming**. Agent command execution, Git worktrees and PR creation remain future work. Session files remain local and are gitignored. See [Agent Workspace setup](docs/agent-workspace.md).

### Docker Execution Boundary (preflight)

The Workspace now includes a [Docker isolation preflight](docs/execution-boundary.md) which checks an ephemeral non-networked, read-only test container. **This is not a runnable agent environment** and does not grant file access or Git permissions.

### Isolated Worker Foundation

The Workspace can now start, ping and stop a [fixed-protocol Docker worker](docs/isolated-worker.md) built locally from `packages/worker`. It does not execute AI or shell commands. The ordinary worker receives no host mounts; PR #15 adds a separate, explicitly gated **ephemeral** read-only mount probe that does not execute code. Build the local image before running its controls; the Docker Safety Preflight must pass first.

### Worktree Plans & Review (PR #9)

The Workspace can preview immutable, repository-scoped [worktree plans](docs/worktree-plans.md), compare SHA-256 fingerprints, record time-limited acknowledgements, and revoke them. Plans do **not** create Git branches, mounts or execution permissions.

### Safe Metadata-only Worktree Creation (PR #10)

An acknowledged [worktree plan](docs/worktree-plans.md) can now be turned into a real, **metadata-only** Git worktree after two separate approvals: a configured local operator secret and a short-lived single-use token. The feature is disabled unless explicitly configured. No project files are checked out and agent execution remains disabled. See [safe worktree creation and setup](docs/safe-worktree-creation.md).

### Worktree Recovery Inspector (PR #11)

The Workspace can run a [read-only Git worktree inspection](docs/worktree-inspection.md) on created or interrupted plans. It validates worktree registration, the pinned commit and Git tree safety before any future checkout. **This does not hydrate files, delete anything, or authorize agents.**

### Explicit Raw Git Worktree Hydration (PR #13)

A created, inspected worktree can be populated from pinned **raw Git blobs** after a second, independent operator-secret approval. [Safe hydration setup, limits, and recovery](docs/worktree-hydration.md). Disabled by default; the process does not execute Git hooks, checkout filters, Codex, or arbitrary commands. Incomplete hydration never auto-cleans or retries.

### Post-Hydration Integrity & Mount Preview (PR #14)

The Workspace can now [verify every copied Git blob against the pinned commit](docs/worktree-integrity.md), detect unexpected files and preview a fixed read-only Docker mount policy. **No actual mounts, Docker actions or Codex permissions are enabled**; the report is diagnostic only.

### Ephemeral Read-Only Worker Mount (PR #15)

An independently approved [read-only Docker mount probe](docs/worktree-mount.md) verifies that an integrity-checked worktree can be bound into a **short-lived, fixed-protocol worker**. The probe always stops and removes the container. **Disabled by default**, it does not enable agent execution or add mounts to the ordinary worker.

### Codex Adapter (opt-in)

The Workspace can now connect to a locally installed Codex CLI and create or resume isolated **read-only** Codex threads. PR #6 adds a separate text-only [Codex Agent Chat](docs/agent-chat.md) using these threads, while keeping worktree and PR mutation disabled. See [Codex Adapter setup and security](docs/codex-adapter.md).

## Verification

```bash
pnpm check
```

The monorepo includes Next.js, NestJS, shared TypeScript/contract packages, and GitHub Actions CI. Agent chat and local session storage are now available. AI-controlled code execution, unrestricted checkout, production authentication and databases are **not** included. Scoped raw-blob hydration is explicitly operator-gated and remains separate from agent execution. Worktree creation is a separate operator-authorized action, never triggered by plan acknowledgement alone.

## Safety and governance

Agents may eventually create branches and PRs but **may not merge** them; the repository owner reviews and merges. Keep credentials local in ignored environment files or a secure secret store. CI has read-only GitHub token permissions and no user credentials.

See [architecture](docs/architecture.md) and [roadmap](docs/roadmap.md).
