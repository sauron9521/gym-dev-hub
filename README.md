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

### Codex Adapter (opt-in)

The Workspace can now connect to a locally installed Codex CLI and create or resume isolated **read-only** Codex threads. PR #6 adds a separate text-only [Codex Agent Chat](docs/agent-chat.md) using these threads, while keeping worktree and PR mutation disabled. See [Codex Adapter setup and security](docs/codex-adapter.md).

## Verification

```bash
pnpm check
```

The monorepo includes Next.js, NestJS, shared TypeScript/contract packages, and GitHub Actions CI. Agent chat and local session storage are now available. AI-controlled code writes, Git worktrees, approval gates and production databases are **not** included.

## Safety and governance

Agents may eventually create branches and PRs but **may not merge** them; the repository owner reviews and merges. Keep credentials local in ignored environment files or a secure secret store. CI has read-only GitHub token permissions and no user credentials.

See [architecture](docs/architecture.md) and [roadmap](docs/roadmap.md).
