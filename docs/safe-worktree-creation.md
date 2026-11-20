# Safe Git Worktree Creation — PR #10

This slice adds **opt-in, single-use operator authorization** to turn an acknowledged PR #9 plan into a real **metadata-only Git worktree** and a dedicated local Git branch. The worktree is created with `git worktree add --no-checkout`: **no files are checked out**, no agent is connected to the worktree and no shell/tool execution capability is granted.

## Local configuration

Dev Hub defaults to **creation disabled**. Add these settings **only to your ignored** `apps/api/.env` (never to source code):

```dotenv
DEV_HUB_REPOS_ROOT=F:\programer
DEV_HUB_ENABLE_WORKTREE_CREATION=true
DEV_HUB_WORKTREE_OPERATOR_SECRET=<generated random secret, at least 32 characters>
```

Generate a strong local secret using:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Paste the result into `apps/api/.env` and restart NestJS. The secret is not exposed to the UI or stored with plans. Avoid committing or sharing it.

Without **both** `DEV_HUB_ENABLE_WORKTREE_CREATION=true` and a 32+ character secret, the authorization and creation endpoints are disabled.

## Workflow

1. Open `http://127.0.0.1:3100/workspace` and choose a Workspace session for an allowlisted, trusted local repository.
2. Create a new worktree plan, review its exact repository, path, branch, fingerprint and acknowledge it (PR #9). The acknowledgement lasts **15 minutes**, but is **not** itself permission to run Git.
3. Enter your separate _operator secret_ in the UI and click **Авторизувати створення**. The backend validates the secret using a constant-time digest comparison, rechecks the plan and local Git HEAD, and returns a random **single-use token valid for 60 seconds**. The token binds session ID, plan ID, plan fingerprint and exact base HEAD commit.
4. Review the exact base commit, then explicitly click **Створити Git worktree без checkout файлів**. The token is removed from memory **before any asynchronous operation**. A replay or parallel duplicate is rejected. The plan switches durably to `creating` before Git is invoked.
5. The API revalidates repository origin, allowed folder, exact HEAD, target root and target vacancy. It calls `git worktree add --no-checkout -b <server-generated-branch> -- <server-generated-target> <approved-sha>` via Node.js execFile, **never a shell command string**. Git hooks are disabled by local CLI config. It then verifies the created worktree references the approved commit.
6. On success, plan state becomes `created`, `worktreeCreated=true`, and audit records `creation-started` / `worktree-created`. No Git remote push or pull request is made.

The source repository's **working tree files are not edited**. Creating a worktree still modifies the source repository's **local Git metadata** (new branch and worktree registrations), and creates an empty checkout directory with a `.git` pointer. There is **no worktree checkout** in PR #10.

## HTTP API

Endpoints extend the PR #9 routes; all are proxied by the same-origin Next.js Workspace API.

| Method | Suffix under `/workspace/sessions/:id/worktree-plans` | Action                                                                                |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| POST   | `/:planId/authorize`                                  | `{ "fingerprint": "sha256:...", "operatorSecret": "..." }`, returns short-lived token |
| POST   | `/:planId/create`                                     | `{ "grantToken": "..." }`, consumes once, creates metadata-only worktree              |

The two endpoints are allowlisted explicitly; there is no generic Git command, Git checkout, code-write, Docker mount or shell execution endpoint.

## Failure and recovery

- `pending`, `acknowledged`, `expired`, `revoked` remain backward-compatible. New states: `creating`, `created`, `failed`. Old persisted manifests still parse.
- Once `creating` is saved, a crash may leave the plan there. A Git failure marks it `failed`. **Neither state grants retry**; a new plan or manual recovery is required.
- **No destructive automatic cleanup is performed**, because a partial Git operation might have created branches/worktree metadata or other local files. Examine `git -C <source> worktree list` and `git -C <source> branch --list 'devhub/task-*'` before deciding on manual cleanup.
- Worktree base SHA cannot drift: changing HEAD after token issuance aborts creation; the grant cannot be replayed.
- This uses in-memory single-use token records. Restarting the API invalidates outstanding tokens; a new authorization is needed.
- Limitations: This is a **local single-process MVP**, not a multi-user authentication system. Do not expose the app to any network. The operator secret must remain private. A local administrator with access to the process, repo or Docker remains trusted; this is not a hardened sandbox for untrusted code.

## Verification

Unit tests build **temporary Git repositories** only, not the user's real `gym-platform`. They verify exact commit pinning, one-time token use, disabled-by-default behavior, forbidden origin/path drift, target collisions, audit and state transition. Manual HTTP tests use an isolated fixture and assert no code execution endpoint exists.

PR #11 adds a [read-only worktree recovery and hydration preflight](worktree-inspection.md) with Git metadata checks and strict Git tree safety rules. It does **not** perform checkout. A separately approved raw-blob materializer and scoped permissions remain future PRs. Keep every merge manual.
