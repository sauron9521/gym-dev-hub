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

## Operator-approved single-file patch apply (PR #63)

**Disabled by default.** This is the first capability that changes worktree
source bytes. It is exclusively for the **local trusted-operator Hub**, not a
remote, multi-tenant application and **not** an arbitrary agent shell. Prereqs:
the existing one-file Docker read, browser diff review, server patch preflight
and a hydrated, verified, pinned Git worktree. Separately set these opt-in flags
in the **ignored local** `apps/api/.env` only after manually reviewing the code:

- `DEV_HUB_ENABLE_PATCH_APPLY=true`
- `DEV_HUB_PATCH_APPLY_OPERATOR_SECRET=<new independent random secret of 32–256 bytes>`

The preflight flags `DEV_HUB_ENABLE_PATCH_PREFLIGHT`,
`DEV_HUB_ENABLE_SCOPED_CODE_READ`, and
`DEV_HUB_ENABLE_WORKTREE_MOUNT` must also be enabled. The write secret is
**not** the existing read secret or a ChatGPT/OpenAI token, and must never be
committed. Never expose the local Hub ports publicly. Stop and disable this
flag if the local machine is shared with untrusted users.

After reviewing the diff, the operator must explicitly approve one file,
commit, and patch and enter the **separate write secret**. The
`patch-apply-authorize` endpoint independently rechecks the exact Git
fingerprint, complete worktree integrity, UTF-8 original SHA-256 and shared
unified diff parser, **then** issues one 45-second, in-memory,
one-time bearer capability bound to exact session, plan, file, commit,
source SHA, patch SHA and proposed SHA. An audit event is required before
the grant can be issued. A second explicit operator action with the write
secret invokes `patch-apply`, immediately consumes the token and takes
both an in-process lock and a per-plan exclusive on-disk lock.

The service rechecks the Git state and source under the lock. It parses the
patch **as data, never executing a command**. The bounded replacement is
written to an exclusive temporary file in the same directory, synced and
atomically renamed over the original **only if the target file identity,
content, permissions and paths still match the approved preimage**. Only
existing non-executable files with mode 0600 or 0644, link count 1, ≤8 KiB
source and ≤12 KiB output are supported; no new/deleted files, symlinks,
hardlinked targets, arbitrary argv, Git commands, shell or hooks.

Audit records (`apps/api/.local/patch-apply/audit.jsonl` by default) contain
timestamps, grant IDs and hashes, **not** secrets, bearer tokens or file
contents. Failures reject further use of the same grant; a crash can leave
a per-plan `.lock` requiring **manual inspection** before removal. An audit
failure after the atomic rename or an interrupted write requires manual
verification: **there is no automatic rollback**. After the first successful
write the original SHA-pinned worktree integrity becomes `mismatch` as
expected; a follow-up review should use Git diff and run tests, not reattempt
another patch against the now-stale pinned source.

**Threat-model limitation:** atomic rename and no-follow descriptor checks
protect against accidental drift, parallel Hub writes and many common path
errors. Node's path-based rename is not a kernel-level openat/renameat2
transaction; a _hostile process running under the same local account_ may
still race directory paths. Do not expose this functionality to untrusted
local processes or treat it as a hardened multi-user sandbox. No push,
commit, pull request or merge is performed; all remain separate later steps
with explicit operator review.

## Post-apply Git diff verification and test preparation (PR #64)

After a successful, separately authorized `patch-apply`, the operator can
request **Перевірити фактичні зміни та Git diff**. This is a **new read-only
operation**; it does not use or issue a write capability. Opt in locally by
setting `DEV_HUB_ENABLE_PATCH_REVIEW=true` in the ignored
`apps/api/.env`, retaining the existing independent
`DEV_HUB_PATCH_APPLY_OPERATOR_SECRET` (32–256 bytes). It remains **off by
default**. Only run this local service on a trusted computer; do not
publish its ports.

`POST /workspace/sessions/:sessionId/worktree-plans/:planId/patch-review`
takes a strict object with the successful apply receipt's grant ID,
fingerprint, pinned commit, one file path, source SHA-256, proposed SHA-256,
and the operator's write secret. The server opens the bounded private
`patch-apply/audit.jsonl` using a no-follow handle, requires one matching
`applied` audit event with **no later rejection for the same grant**, and
rechecks the allowed session, repository, plan and Git revision.

A dedicated overlay mode on the existing Git integrity service verifies
that the **one approved tracked file** has exactly the audited post-image
SHA-256 and safe file metadata; it verifies the original file's SHA-256
against the pinned raw Git blob and checks **every other tracked file**
against its exact original Git blob. Missing files, unexpected files or
directories, symlinks and source drift are rejected. Normal `verify()`
behavior remains unchanged: an intentionally edited file still fails
the original baseline check as expected.

After verifying, the service runs **only fixed, read-only Git diff
commands**, with hooks, textconv, external diff, system/global Git config
and Git lazy fetch disabled. It requires precisely one changed path
and returns the real, bounded unified diff for operator review. It
revalidates all files once again and refuses to review while a patch
writer lock exists.

The response includes SHA-256 hashes, file/commit, checked-at time, exact
changed-file count and informational test/typecheck recommendations for
the known repository/package. The UI displays the diff and next steps.
**No tests have been run**, no project script has been executed, and no
commit, push, GitHub PR or merge is created. Recommendations are plain
text, not executable commands or grants.

This is a point-in-time review and **not** a guarantee of safety against
hostile same-account processes racing directory paths after verification.
A future implementation slice may introduce separately approved,
fixed Docker test recipes for a reviewed changed worktree, followed by
explicit commit/push/PR steps; none are authorized by this result.

## Fixed post-apply Docker typecheck/test checks (PR #65)

This is an **explicit opt-in, local-only, trusted-operator execution
capability**. Unlike post-apply Git review, a TypeScript compiler and Vitest
do execute project-supplied configuration and tests, so this runs only
inside a disposable sandbox. The Hub still cannot accept an arbitrary
command, test file, package, image, volume, environment or Git operation
from an agent or browser.

**Four fixed recipes, only for Gym Dev Hub**, chosen according to the one
previously approved changed source file:

| Source file       | Allowed fixed recipes        |
| ----------------- | ---------------------------- |
| `apps/api/src/**` | `API_TYPECHECK` / `API_TEST` |
| `apps/web/src/**` | `WEB_TYPECHECK` / `WEB_TEST` |

Changes to docs, configs or any other paths cannot enable a Docker check in
this first slice. The endpoint requires **one successful audited patch-apply
receipt** and a fresh, server-verified, read-only post-apply Git review
from PR #64, including full-tree Git integrity and one exact post-image
SHA-256. The review is repeated before authorization, immediately before
Docker, and after the container is removed.

An operator separately enables
`DEV_HUB_ENABLE_PATCH_CHECKS=true`, sets a newly generated independent
`DEV_HUB_PATCH_CHECK_OPERATOR_SECRET` (32–256 bytes), and retains the
post-apply review prerequisites, including
`DEV_HUB_ENABLE_PATCH_REVIEW=true` and
`DEV_HUB_PATCH_APPLY_OPERATOR_SECRET`. The Docker safety preflight must
have passed within five minutes. The operator must supply **both** secrets
to authorize a single recipe and again to execute it. The new token is
cryptographically random, stored only as a hash, valid 45 seconds, bound
to exact session, plan, original grant ID, recipe, commit, file path,
fingerprint, and source/post-image hashes, and consumed before any await.
A distinct cancellation endpoint accepts the operator secret and matching
run ID. Failed runs cannot be replayed.

**Provisioning is manual and never performed by the API**: rebuild the
trusted `gym-dev-hub-node-runner:v1` image from the updated
`packages/runner/Dockerfile` (which now contains
`patch-checks-local.mjs`) and pin its real Docker SHA256 image ID in
`DEV_HUB_PATCH_CHECK_IMAGE_ID`. Configure a complete **offline,
script-free** pnpm 12 store as absolute canonical
`DEV_HUB_PATCH_CHECK_PNPM_STORE`, available inside the Docker mount and
containing the dependencies from the repository's unchanged lockfile.
For Alpine (musl), provision both `linux-x64` and `linux-x64-musl`
optional packages from the exact reviewed lockfile using pnpm
`supportedArchitectures`; a Linux-glibc-only cache is insufficient for
native Rollup/Vitest binaries. Provision with no package lifecycle scripts
and verify the lockfile remains unchanged. The **read-only** host store is
copied (with bounds and no untrusted symlinks) into container-private
`/workspace/.pnpm-store`, excluding pnpm's host `v11/projects`
bookkeeping links. pnpm 12 can update its local SQLite index in this private
copy. Install uses `--offline --frozen-lockfile --ignore-scripts
--trust-lockfile`; the last flag is allowed here **only after** the Hub has
independently verified every Git blob of the original, immutable lockfile
and the one approved postimage. pnpm still checks package bytes/integrity.
The pnpm CLI is invoked through an exact Node executable path rather than
a shell wrapper, to work with `shell:false`.

Missing image, store, dependency closure, stale Git or credentials cause
fail-closed rejection; the API never builds images or downloads packages.
The image tag alone is never enough; its exact ID and expected non-root,
Linux/amd64, disabled-by-default entrypoint labels must match.

The container:

- receives two **read-only bind mounts**, the validated one-file worktree
  and the trusted pnpm store; the host Docker socket is never mounted
- has `--network=none`, read-only root filesystem, UID/GID 65534,
  cap-drop ALL, no-new-privileges, IPC none, pids 128, 5 GiB memory,
  2 CPUs, bounded output and timeout, then mandatory forced cleanup
- stages only bounded, non-symlink source files (max 5,000 files / 100 MiB)
  into a private ephemeral scratch volume and matches the approved
  post-image SHA before installing dependencies
- installs dependencies offline with `--ignore-scripts` and
  `--frozen-lockfile`, builds shared TypeScript declarations, then
  runs a **static** Node CLI path to TypeScript or Vitest, no shell or
  package lifecycle scripts; never executes the original host source
- uses an executable **private** `/workspace` tmpfs for native test
  workers such as esbuild, while `/tmp` and `/results` stay noexec;
  source/store mounts and host root stay read-only.

The response is a **structured passed receipt** with bounded byte counts
and explicit `commitCreated:false`, `pushEnabled:false`,
`mergeEnabled:false`. Failed tests, timeouts, cancellations, integrity
drift, malformed receipts and Docker cleanup failures report failure,
not success. Only secret-free hashes and run events are written to the
private `.local/patch-checks/audit.jsonl`; raw arbitrary project logs
are not exposed in HTTP responses.

**Limitations:** This is not a security boundary against malicious code
exploiting kernel/runtime vulnerabilities. It is intended for local,
trusted-operator projects only; never expose the Hub to the internet.
A privileged/untrusted same-UID host process may still race filesystem
paths. The offline package closure, Docker image and actual container
execution must be manually provisioned and smoke-tested; unit/CI checks
alone cannot prove a runnable local Docker configuration. No automated
commit, push, PR, merge, rollback or follow-up tests are implied by a
single passed check.

The reviewed Docker image also includes Git strictly for project tests that
create their own **temporary** Git repositories inside scratch. The original
source's `.git` metadata is never mounted into the container. Vitest uses
a static single-worker/no-file-parallelism recipe to avoid heavy Git fixture
timeouts under the 2-CPU and 128-process sandbox limits.

## Historical post-apply Docker check reports (PR #66)

See [patch-check-history.md](./patch-check-history.md) for the
independent-secret-protected, local-only read-only history endpoint and
Workspace panel. The new history is a bounded projection of the existing
private PR #65 audit: statuses, timestamps, elapsed time and byte counts
only, with no raw logs or replay. The existing opt-in and authorization
requirements still apply to **new** Docker runs.

## Read-only Git commit candidate review (PR #67)

See [commit-candidate-preview.md](./commit-candidate-preview.md) for the
**disabled-by-default** commit message, diff hash and Docker-check
evidence preview. It has a separate manual one-time acknowledgement,
but no Git staging, commit, push, PR creation or merge authority.

## Operator-only local one-file Git commit (PR #68)

See [local-git-commit.md](./local-git-commit.md). The explicit one-use
local commit grant is **disabled by default**, requires its own Git
secret and configured author identity, and is separate from reviewing
a PR #67 candidate. Only the approved task ref can advance; no push,
GitHub PR creation or merge is provided.
