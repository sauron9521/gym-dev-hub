# Agent Workspace Foundation (PR #4)

This is the **local session and task foundation**. PR #5 added an opt-in [Codex app-server connection](codex-adapter.md) with read-only thread IDs. PR #6 now adds a separate [Codex AI Chat](agent-chat.md) with streamed text responses and saved history. A Workspace session contains one repository, one implementation task, a lifecycle status, and notes. Open several sessions in parallel browser tabs, and switch between them without losing their notes.

## Start

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:3100/workspace`, or follow **Agent Workspace** from the Dashboard. The API listens only on `127.0.0.1:3101` by default.

Create a session with a title, one of the configured GitHub repositories, and task/acceptance criteria. Use **Заплановано → У роботі → Очікує review → Завершено** as the task lifecycle. Use the note composer to save milestones, decisions and PR references. Multiple sessions can be open as separate UI tabs; closing a tab does **not** delete its data.

Workspace notes remain local user notes, separate from the AI chat. A user may now explicitly send a prompt to a linked Codex thread; this does not grant code write, shell execution, branch creation, PR or merge permissions. See the [security limitations](agent-chat.md).

## Persistence

The NestJS API stores the records in a versioned JSON file, by default `apps/api/.local/agent-workspace.json` when started with `pnpm dev` from the repository root. All `.local/` directories are gitignored. The path can be overridden with an absolute `DEV_HUB_WORKSPACE_FILE` set in `apps/api/.env`.

Writes use a temporary file and rename, and are serialized within one NestJS process to prevent concurrent edits from being lost. Corrupt or incompatible files cause an explicit error, not automatic data replacement. There is no delete endpoint; sessions stay available after a tab is closed. For now, limit is 50 sessions, 100 notes per session and 4000 characters per note.

**Limitations:** this simple file-based store must only be used by **one API process**, on a local machine. Multi-process consistency, backups, database migrations, and remote collaboration require a later PostgreSQL/Prisma store. Do not edit the JSON file while the server is running.

## Planned shared agent memory

Cross-session verified memory, task leases, and external MCP integration are **not** implemented by this local JSON Workspace. See the proposed [Shared Agent Memory ADR](architecture/shared-agent-memory.md) for storage, provenance, operator approval, repository scoping, and migration safety. Existing sessions and JSON notes remain unchanged.

## HTTP endpoints

| Method | Endpoint                           | Purpose                                    |
| ------ | ---------------------------------- | ------------------------------------------ |
| GET    | `/workspace/sessions`              | Session summaries and repository allowlist |
| POST   | `/workspace/sessions`              | Create a session                           |
| GET    | `/workspace/sessions/:id`          | Read complete session and notes            |
| PATCH  | `/workspace/sessions/:id`          | Update status, task or title               |
| POST   | `/workspace/sessions/:id/messages` | Add user note                              |

The Next.js UI uses a same-origin route proxy under `/api/workspace/*`. It accepts only these paths and methods, validates UUID segments, restricts JSON request size and refuses cross-origin write requests. NestJS validates request bodies with Zod and ensures repository names are allowlisted.

## Security

- The backend is **not authenticated**: this prototype must remain loopback-only. Do not expose ports 3100/3101 to a public network or place it behind a proxy without authentication.
- Do not store API keys, credentials or secrets in user notes.
- Local session files are not committed to GitHub; removing the Dev Hub repo does not affect `gym-platform`.
- AI/Codex integration, secure session identities, worktree isolation, and production database storage are separate future PRs.
