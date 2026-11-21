# PR #69 — separately authorized new GitHub task branch publication

A **manual localhost pilot** to publish a single already committed,
audited one-file worktree task branch from PR #68. This is not
unattended agent publishing, arbitrary `git push`, automatic pull
request creation or merging.

## Why Git Data API instead of `git push`

The server uses only fixed HTTPS GitHub REST Git Data endpoints, scoped
to `sauron9521/gym-dev-hub`. It creates the exact pinned blob, tree
and commit objects and **atomically creates** one previously absent
`refs/heads/devhub/task-<32hex>` ref. It never invokes the Git
protocol with a credential, never uses force or PATCH update-ref, and
never accepts arbitrary remote URLs/branches/refs from clients.
An existing remote branch is rejected even when fast-forward would be
possible; an HTTP 422 during branch creation is not retried.
This also protects GitHub `main` from accidental publishing.

GitHub supports Git Data API blob, tree and commit creation and
creation of new references, requiring repository **Contents: write**
permission. The server explicitly verifies that GitHub returns the
**same SHA-1** for each local Git object before attempting to create
a ref. If GitHub normalizes a commit differently and SHA differs, it
**fails without creating a branch**. No rebase, rewrite, amend or
re-generated replacement commit is used.

## Explicit local opt-in

Configure these only in the **ignored**, private Hub API local env,
never in a tracked file, agent message or chat:

```ini
DEV_HUB_ENABLE_GITHUB_PUBLISH=true
DEV_HUB_GITHUB_PUBLISH_OPERATOR_SECRET=<fresh independent random secret, 32–256 bytes>
DEV_HUB_GITHUB_PUBLISH_TOKEN=<repo-scoped fine-grained token, Contents:write>
```

The token should be granted only for `sauron9521/gym-dev-hub`, using
the smallest permissions practical. Existing dashboard
`GITHUB_TOKEN` is **not** reused. The separate operator secret is
typed into the browser (not the GitHub credential). Keep the API and
Web Workspace **bound to loopback only**. This new capability is
**disabled by default**. The feature does not install, request or
expand permissions on an existing GitHub token.

All earlier worktree, patch approval, Docker check and local commit
gates remain independent. The API requires that the PR #68 durable
commit audit contains exactly one successful commit with the same
session, plan, source commit, file path hash and subject hash.

## Operator workflow

Following the successful local Git commit in a disposable task
worktree, Workspace displays **Опублікувати нову task-гілку**:

1. Read the commit SHA and exact task branch. Tick the explicit
   acknowledgement, enter the **GitHub publish operator secret**,
   and select **Дозволити створення нової гілки**. The server
   validates the local commit and private audit, checks the remote
   branch is absent, and issues a 45-second, one-use grant.
   **No remote Git write occurs yet.**
2. Enter the operator secret **again** and select
   **Створити цю remote task-гілку**. The grant is consumed before
   awaits. The server takes the same exclusive per-plan commit lock,
   records an attempted event, repeats full Git/audit verification,
   uploads exact objects, repeats local verification immediately
   before remote ref creation and requests the atomic new branch.
3. The server confirms the new ref exists at the exact intended
   commit SHA, writes a success audit and releases the lock. UI
   shows the GitHub task branch link. No pull request is created.

Strict POST endpoints:

```text
POST /workspace/sessions/:sessionId/worktree-plans/:planId/github-push-authorize
POST /workspace/sessions/:sessionId/worktree-plans/:planId/github-push-execute
```

Authorization JSON must contain only `commitSha`, `operatorSecret`
and `confirmation: "I_AUTHORIZE_NEW_TASK_BRANCH_ONLY"`.
Execution JSON must contain only `grantId`, `grantToken`, `runId`,
`operatorSecret` and
`confirmation: "I_PUBLISH_THIS_EXACT_COMMIT_TO_NEW_TASK_BRANCH"`.
Neither endpoint accepts commands, remote names, URLs, force flags,
new author identities, paths or branch overrides.

## Verification and recovery

Before any remote write, the verifier checks:

- A fully created/hydrated scoped Gym Dev Hub worktree and exact
  `devhub/task-<32hex>` symbolic HEAD
- A clean local worktree and Git index, exactly one tracked
  non-executable source-file change relative to the pinned original
  parent commit (at most 12 KiB)
- Git SHA-1 for blob/tree/commit, original parent, commit message,
  author/committer dates, and exact PR #68 durable `committed`
  audit event; mismatches fail closed
- Remote GitHub branch still **absent**, with an atomic GitHub
  `POST /git/refs` creation rather than update/force

Local audit: `apps/api/.local/commit-write/github-push.jsonl` (or
the directory supplied by `DEV_HUB_COMMIT_STATE_DIR`), bounded to
1 MiB, fsynced, restrictive POSIX permissions. Only grant/run IDs,
timestamp, SHA, branch, plan/session IDs and status are stored;
**never** source, tokens, operator secrets or HTTP responses.
The same `<planId>.lock` used by the commit feature serializes
Git operations for that plan.

If GitHub times out, returns an uncertain response or the ref cannot
be verified after attempting creation, **do not retry**. The
per-plan lock remains for manual inspection of GitHub remote branch,
local HEAD/index and the audit. Object uploads may leave unreferenced
objects if publication aborts before branch creation; these objects
do not constitute a published branch.

Automated tests use disposable real Git repositories with fake GitHub
HTTP responses, including SHA mismatch, already-existing branch,
race, ambiguous remote outcome, grant replay, concurrency and secrets.
They do **not** publish a real branch to your account. Manually test
the real-token browser flow on a disposable task worktree **before**
enabling it for regular development.

**Next PR**: separately authorized creation of a draft GitHub pull
request for the published branch, CI status tracking and owner-only merge.
