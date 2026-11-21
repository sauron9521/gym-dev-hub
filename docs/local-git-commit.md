# PR #68 — operator-only, one-file local Git commit

This is a **local trusted-operator pilot**, not a general Git command API
or unattended AI-agent workflow. It creates exactly one Git commit in an
existing, fully reviewed, isolated `devhub/task-<32hex>` worktree branch.
It never pushes code, creates a GitHub PR, changes `main` or merges.

## Prerequisites

Complete the explicit PR #63–67 pipeline in the Gym Dev Hub repository:
one SHA-pinned worktree; one approved one-file patch; post-apply Git
integrity review; at least one matching _passed_ fixed Docker test;
a read-only conventional commit candidate; and explicit human
acknowledgement of that exact candidate.

In the **ignored** local `apps/api/.env` explicitly opt in after review:

```ini
DEV_HUB_ENABLE_GIT_COMMIT=true
DEV_HUB_GIT_COMMIT_OPERATOR_SECRET=<new independent random 32–256 byte secret>
DEV_HUB_COMMIT_AUTHOR_NAME=<your chosen Git display name>
DEV_HUB_COMMIT_AUTHOR_EMAIL=<your chosen valid email>
```

The commit secret must differ from the PR #63 patch-write and PR #67
candidate-review secrets. Do **not** commit credentials or use an agent
chat as an input channel for them. Git author name/email are **explicitly
configured**; the Hub does not infer a person's identity from Git config.
The existing candidate-preview flag and both review secrets must still
be enabled and available. All Git commit write features are **off by
default**. The API and dashboard must remain bound to loopback.

## Workflow

In Workspace, after **operator-reviewed** candidate confirmation, open
**Local Git commit**. Review the scope and enter the three independent
secrets (post-apply review, candidate preview, and Git commit write):

1. Checkbox and **Дозволити один Git commit** consume the stored
   short-lived human-review evidence, repeat the source Git/diff/Docker
   checks, and issue a 45-second one-use capability. **No Git write yet.**
2. Re-enter the secrets and click **Створити цей локальний commit**.
   The server consumes the capability _before any async work_, acquires
   an exclusive private per-plan lock, writes an `attempted` audit
   record, repeats Git integrity and Docker-check evidence, and commits
   exactly the reviewed file to the dedicated task branch.
3. On success the UI shows the new SHA, old parent SHA and task branch,
   and confirms a clean worktree. No remote push or pull request occurs.

Server routes use strict JSON POST bodies:

```text
POST /workspace/sessions/:sessionId/worktree-plans/:planId/commit-write-authorize
POST /workspace/sessions/:sessionId/worktree-plans/:planId/commit-write-execute
```

The first action requires `candidateId`, `candidateSha256`, three
independent operator secrets, and the exact confirmation
`I_AUTHORIZE_ONE_LOCAL_GIT_COMMIT_GRANT`.
The second accepts `grantId`, `grantToken`, `runId`, the same
secrets and `I_EXECUTE_THIS_ONE_LOCAL_GIT_COMMIT_ONLY`.
No browser-provided command, target branch, path, Git argv, arbitrary
author identity, remote, or repo override is accepted.

## Git safety

The backend verifies that `HEAD` is the expected original pinned
commit and its symbolic ref is the original
`refs/heads/devhub/task-<32hex>`. It rejects staged changes or
non-regular/non-0644 approved files. Only the approved 12 KiB maximum
regular file is read with `O_NOFOLLOW` and hashed.

It then uses **fixed Git plumbing only**, with an isolated temporary
index instead of `git add`: `hash-object -w --no-filters --stdin`,
`read-tree`, `update-index --cacheinfo`, `write-tree`,
`diff-tree`, `ls-tree`, `commit-tree`, and finally
`update-ref <task-branch> <new-commit> <expected-old-commit>`.
A final full Git and Docker evidence check precedes the atomic
**compare-and-swap** branch update. Git hooks, signing, shell execution,
interactive Git authentication, filters and normal index staging are
disabled/avoided. The real index is synchronized to the new HEAD after
the ref update; tracked files remain in the worktree unchanged.

Every step runs with a minimal Git environment and bounded timeout and
output. Never use this operation in an untrusted same-UID process
environment: other local processes can still race paths or Git refs,
and this feature is not a hardened multi-user security boundary.

## Audit and recovery

A bounded (1 MiB) private, fsynced audit is created in
`apps/api/.local/commit-write/audit.jsonl` by default, or a separately
configured local absolute `DEV_HUB_COMMIT_STATE_DIR`.
It records `issued`, `attempted`, `committed` or `rejected` with
timestamps, ID and **hash-only** metadata; never raw code, full path,
subject, secrets, tokens, Git command output or diffs.
Directory/log modes are 0700/0600 on POSIX; symlinks, hard links and
unexpected permissions fail closed.

A per-plan `<planId>.lock` is created exclusively before the Git
write and is retained if an error occurs **after the Git ref may have
advanced**. Do **not** blindly delete a leftover lock or retry the
request: inspect `git log -1`, `git status`, task ref, real index and
audit manually. The API reports the commit as **unconfirmed** rather
than inventing a successful rollback. If the process crashes, the lock
remains for an operator to investigate. A failed/replayed token cannot
be reused.

This initial release supports **one pre-approved existing source file
per commit**. Creating/deleting multiple files, branches from the UI,
remote push and GitHub PR creation require **separate small PRs**, and
merge always stays manual.
