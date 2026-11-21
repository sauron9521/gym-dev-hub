# Agent Chat: Codex read-only conversations (PR #6)

This milestone adds opt-in **text conversations with Codex** to the independent Gym Dev Hub. The backend uses the user's local Codex CLI login and Codex app-server JSON-RPC protocol; no API key is added to the Next.js browser.

## Usage

1. Run `pnpm dev` in `F:\programer\gym-dev-hub` and open `http://127.0.0.1:3100/workspace`.
2. Create or open a Workspace session.
3. Click **Підключити Codex** and **Прив'язати Codex thread**. The thread stays bound to this Workspace session.
4. Type into the separate **AI Chat** composer and click **Надіслати до Codex**. Notes remain separate from the AI conversation.
5. The browser receives incremental assistant text using Server-Sent Events. Conversation history is stored locally and survives reopening the page and restarting the API.

The chat uses `turn/start` with a `readOnly` sandbox, `networkAccess=false`, and `approvalPolicy=never`. If a tool attempt appears in a Codex item notification, the adapter interrupts the turn. Unexpected approval requests are always rejected. Optional shell, browser, multi-agent, plugin and web search features are disabled by per-thread config where supported, and thread instructions ask for text-only answers.

**Security limitation:** a Codex read-only sandbox may still allow the model to read local files and potentially execute read-only commands, depending on the host, CLI version and enabled tools. Notification-based interruption happens after an item starts; it is not a substitute for OS-level isolation. **Do not use this prototype for untrusted prompts or sensitive repositories.** Proper command-free tool policy or a separately constrained OS process is required before promising hard zero-shell access. PR #7 adds a [Docker preflight](execution-boundary.md) for a standalone diagnostic container; it does **not** move Codex into Docker. Future worktree execution must have explicit user approval and permissions.

## API

All requests remain on `localhost`, with same-origin Next.js routing through `/api/workspace/*`:

| Method    | NestJS endpoint                       | Meaning                                                             |
| --------- | ------------------------------------- | ------------------------------------------------------------------- |
| GET       | `/workspace/sessions/:id/chat`        | Saved user/assistant messages plus current turn status              |
| POST      | `/workspace/sessions/:id/chat`        | Start a text-only Codex turn for the linked session                 |
| GET (SSE) | `/workspace/sessions/:id/chat/events` | Initial snapshot, progressive text, completion and heartbeat events |

JSON requests contain `{ "content": "message" }`. Prompts are limited to 3000 characters, assistant responses to 20000 characters, and chat transcripts to 100 entries per session. Only one active turn per session/thread is allowed; duplicate requests are rejected. Turn timeout: 120 seconds.

SSE is proxied without buffering, and the browser falls back to polling when the connection is unavailable. The backend stores each accepted user message first, then the assistant's completion/failure response. A process interruption _during_ a running turn can leave a user message without a corresponding assistant response; interruption recovery is a follow-up item.

The persisted Workspace JSON format is backwards-compatible with sessions from PRs #4 and #5: a `chatMessages` array is optional on existing records. No Prisma migration is needed.

## Boundaries

- Dev Hub has no user login yet: **only run locally; do not expose 3100/3101**.
- Codex credentials stay in the user's local Codex CLI configuration. The child process receives a minimal environment that excludes GitHub tokens, DB URLs and other application secrets.
- Prompts can be processed by OpenAI services according to your connected Codex account. Never paste passwords, tokens or other secrets.
- There are **no code writes, worktree modifications, branch pushes or PR creation endpoints in this milestone**. All merges remain manual.
- The next PR can introduce an authenticated, OS-isolated execution workspace and explicit user approval gates for development agents.

## Reviewed one-file worktree context (manual draft)

An authorized, successfully hydrated and integrity-verified worktree can provide
one source file using the existing **one-file scoped Docker read**. That separate
feature requires its own flags, worker image, recent Docker preflight, operator
secret and one-time grant; enabling worktree creation alone does not enable
reading.

After a successful code read, **Підготувати пропозицію зміни в Codex** builds a
local text draft containing the exact returned file, its relative path and the
pinned Git commit. It does **not** call the Codex API, execute commands, stage a
patch, or write source files. In the session's AI Chat, **Вставити чернетку в чат**
is a second explicit step. The operator must edit the placeholder task and
press the existing **Надіслати до Codex** button before code is transmitted to
OpenAI. The current chat limit is 3000 characters; files that do not fit are
rejected **without truncation**, so a smaller file must be selected. The draft
is not persisted unless the operator sends it; no tokens or operator secrets
are included.

The AI response is an **untrusted proposed unified diff**, not an applied
patch. Human review, deterministic validation, per-worktree code-writing
authorization, fixed isolated test recipes and GitHub PR creation require
**separate future changes**. No GitHub push or merge capability is enabled.
