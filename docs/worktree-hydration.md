# Safe Worktree Hydration & Non-destructive Recovery (PR #11)

This slice adds an opt-in, **separately authorized file hydration step** for a Git worktree created by PR #10. It does **not** change source-repository working-tree files, mount source code into Docker, start Codex, or execute agent shell commands.

## Configuration

The new action is **disabled by default**. Set both creation and hydration flags in the local ignored `apps/api/.env`, alongside an existing operator secret:

```dotenv
DEV_HUB_ENABLE_WORKTREE_CREATION=true
DEV_HUB_ENABLE_WORKTREE_HYDRATION=true
DEV_HUB_WORKTREE_OPERATOR_SECRET=<existing random secret of at least 32 characters>
```

Never commit your secret. The Dev Hub API remains localhost-only and is not a multi-user authenticated service.

## Workflow

1. Create and acknowledge a plan, then **authorize and create a metadata-only worktree** via the PR #10 flow. The worktree starts with only a `.git` pointer.
2. In Workspace choose **Перевірити вміст і безпеку**. The API confirms exact Git worktree root, common `.git` directory, branch and pinned commit.
3. It reads `git ls-tree -rlz` for the pinned SHA, **without checking out files or executing Git filters, hooks, smudge actions or user commands**. It rejects symlinks, submodules/gitlinks, unsafe path segments (including Windows reserved names), case-insensitive collisions and oversized trees **before writing anything**.
4. Review the displayed number of files, bytes and SHA-256 tree fingerprint. Enter the separate operator secret to authorize the exact snapshot. The resulting token is single-use, valid for 60 seconds, and scoped to session ID, plan ID and fingerprint.
5. Explicitly click **Наповнити Git worktree**. The token is consumed before asynchronous work; the plan transitions durably to `hydrating`. The API rechecks Git ownership and fingerprint, then copies **raw Git blobs only**, using exclusive file creation. No standard Git checkout is invoked.
6. On success, the plan becomes `hydrated` with counts and audit history. Execution permission stays **false**.

### Safety limits

| Constraint | Limit |
| --- | --- |
| Files per tree | 3,000 |
| Bytes per file | 2 MiB |
| Aggregate bytes | 48 MiB |
| Simultaneous runs per plan | 1, enforced by durable state |
| Permissions of new files | Restricted, non-executable on POSIX |
| Symbolic links and gitlinks | Rejected |
| Host-side Git filters and hooks | Not used in hydration |
| Agent commands, Docker mounts, Git pushes and merge | Not implemented |

If a tree exceeds the limits or contains unsupported file types, the preflight is **blocked**. Do not disable the restrictions for untrusted sources merely to force a checkout. A future PR can introduce a faster streaming parser with separately audited limits.

## Failure and recovery

`hydrating` is persisted **before** file writes. If writing fails, the plan becomes `hydrate-failed` and includes an audit record. A process crash may leave `hydrating`; both states appear as **manual-review**, not automatically retryable. The API never deletes a worktree or files on failure, to avoid data loss. Inspect the affected worktree and Git metadata manually before deciding on cleanup. This PR does not expose a destructive cleanup endpoint.

Inspect: `GET /workspace/sessions/:sessionId/worktree-plans/:planId/hydration`.

Authorize: `POST .../:planId/hydration/authorize` with `{ "fingerprint": "sha256:...", "operatorSecret": "..." }`.

Apply: `POST .../:planId/hydration/apply` with `{ "grantToken": "..." }`.

All routes are explicitly allowlisted in the same-origin Next.js proxy. Unknown commands and arbitrary paths are never accepted from the browser.

## Security limitations

This is a **trusted local prototype**, not an OS-level sandbox. A local administrator or process with filesystem access remains privileged. External files are never cleaned automatically, but a failed hydration may leave partially written new files. The worktree should not be exposed to Codex until further hardening (OS-isolated worker, explicit per-path approval, tool restrictions, cancellation and cleanup/recovery). The dedicated Docker worker remains non-executing.

Tests use **disposable local Git repositories** in CI, never the user's `gym-platform`. Windows-specific filesystem behavior is verified by a targeted Windows GitHub Actions job in addition to the normal Ubuntu build/test workflow.
