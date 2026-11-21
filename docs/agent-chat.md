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

## One-file Codex patch preview (PR #61)

After the separately approved one-file Docker read from a verified, SHA-pinned
worktree, the Workspace UI shows **Перевірити запропонований AI-патч**. The
operator can copy the unified diff returned by Codex and paste it into the
preview textarea. The browser checks the diff _in memory_ against the exact
previously returned source bytes and the read grant's pinned Git commit.
This does not execute a command, modify any file, make an API request, call
Codex or record an authorization. The diff is not persisted.

For this initial fail-closed format, only **one existing text file**, exact
`--- a/path` / `+++ b/path` headers, standard unified hunk ranges and
optional exact `diff --git` / `index` headers are accepted. A whole
`diff` Markdown fence is accepted. Every removed/context line must match
the actual verified source and every hunk line count/position must agree.
No rename, creation, deletion, mode change, symlink, binary patch, extra file,
free-form text or context mismatch is allowed. Source is limited to 8 KiB,
the patch to 20,000 characters, the resulting file to 12 KiB, and at most
20 hunks / 200 edited lines. The first slice only handles LF text with a
final newline; unsupported files fail visibly instead of being normalized
or truncated.

The UI previews added/removed/context rows with original/new line numbers and
labels the result **read-only**. An accepted preview is **not** evidence that
the on-disk worktree is still unchanged. A future, separately approved
patch-application PR must re-check worktree provenance and the exact current
Git/source revision, prevent races, and provide its own authenticated,
single-use write capability. No applied code, tests, branches, pushes,
or pull requests are produced by this preview.

## Operator patch preflight — PR #62

After a successful local browser diff preview, the operator can explicitly ask
NestJS to re-check the source and diff **without any write grant**. This is a
separate opt-in. In local ignored `apps/api/.env` enable
`DEV_HUB_ENABLE_PATCH_PREFLIGHT=true` **only after** configuring the existing
`DEV_HUB_ENABLE_SCOPED_CODE_READ=true`,
`DEV_HUB_ENABLE_WORKTREE_MOUNT=true` and strong
`DEV_HUB_WORKTREE_OPERATOR_SECRET`. The feature is off by default, and
the existing one-file read still requires its own separate approval, Docker
preflight and pinned worker as documented above.

`POST /workspace/sessions/:sessionId/worktree-plans/:planId/patch-preflight`
takes a strict bounded body containing `fingerprint`, `sourceCommit`,
`filePath`, `expectedSourceSha256`, `patch`, and `operatorSecret`.
The Next same-origin proxy has an explicit allowlist and a 30k character cap
only for this route (10k for other routes). No browser persistence of the
secret or patch is added. The API checks the operator secret, allowed session
and hydrated plan, pinned Git commit and fingerprint; performs **full worktree
Git integrity checks before and after** a bounded no-follow file read;
verifies the exact source SHA-256; and validates the diff using the _same pure
unified-diff parser_ used by the browser (shared `@gym-dev-hub/contracts`).

The result includes commit, fingerprint, path, timestamp, SHA-256 hashes of
source/patch/proposed content, +/- counts, and the literal fields
`writeEnabled: false`, `authorizationGranted: false`,
`readOnly: true`. It deliberately does **not** return file content,
create an operator token, change the worktree, stage a patch, run a script,
start a worker, or submit a PR. The endpoint itself is only safe for the
local-only Hub; there is no general account authentication.

**Critical:** even a successful second integrity check is a _point-in-time_
diagnostic and cannot prevent a subsequent local process from modifying files.
A later patch-write implementation must revalidate its own state atomically,
with an independently issued, single-use operator grant, bounded write target,
race-safe file operations, audit and cleanup. Never convert this response into
permission to modify files.
