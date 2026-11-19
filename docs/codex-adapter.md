# Codex App Server Adapter (PR #5)

This milestone adds an opt-in **Codex connection and thread binding** to the existing local Agent Workspace. It is deliberately _not a chat runner_ and does not call `turn/start`, execute commands, edit files, or create Git branches/PRs.

## Prerequisites

Install Codex CLI on your local machine and sign in:

```sh
codex --version
codex login status
```

The adapter has been developed against Codex CLI `0.169.0`. Protocol schemas were checked from this installed version using `codex app-server generate-ts`; no generated schema or authentication credentials are committed.

Run `pnpm dev` from the `gym-dev-hub` repository and open `http://127.0.0.1:3100/workspace`. Press **Підключити Codex** to start a local native `codex app-server` process over JSON-RPC / stdio. A successful `initialize` / `initialized` handshake appears in the connection status.

On Windows, the adapter defaults to the native executable distributed with the globally installed npm package `@openai/codex`. For other Codex installation layouts, set `CODEX_EXECUTABLE` to an **absolute path to the native Codex executable** in `apps/api/.env`. For macOS/Linux, `codex` is resolved using the process PATH.

## Link a Workspace session

Create or open a Workspace session, then press **Прив’язати Codex thread**. The app-server receives a `thread/start` request with:

- `cwd` inside `apps/api/.local/codex-sessions/<session-uuid>`, never inside `gym-platform`
- `sandbox: "read-only"`
- `approvalPolicy: "never"`

The Codex thread ID is saved in the versioned, gitignored Workspace JSON file (`codexThreadId`). Press **Підключити thread** to reattach. While the same app-server process is alive, an already loaded thread is reused without an extra RPC request. After restarting NestJS, the adapter tries `thread/resume` using read-only permissions. **Codex does not persist a thread rollout until the first AI turn**: if a linked thread is still empty and Codex returns `no rollout found`, the adapter creates a fresh empty read-only thread, replaces its saved ID and informs the user. No conversation history is lost, since this milestone never starts a turn. Threads with an existing persisted rollout are resumed normally.

The adapter **rejects server-initiated approval requests**, does not expose any generic JSON-RPC invocation endpoint and never passes user-supplied shell commands. It does not copy `gym-platform` into the Codex session directory and does not send the task text as a prompt.

## Endpoints

- `GET /workspace/codex/status`: connection state without spawning Codex
- `POST /workspace/codex/connect`: explicit local connection and handshake
- `POST /workspace/sessions/:id/codex`: create/resume thread for that local session

The browser routes the same calls through the existing same-origin, allowlisted `/api/workspace/*` proxy. No direct browser-to-Codex transport is exposed. On the current host, the backend and Web are loopback-only and have no login authentication; **never expose them to public networks**.

## Future PRs

Live prompts, streaming notifications, approval UI, per-task Git worktrees, safe command execution, durable database storage and GitHub PR creation will be separate milestones. Any code execution must require explicit user consent and isolated worktrees; automatic merge remains forbidden.

Reference: [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
