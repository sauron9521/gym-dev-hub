# PR #13 — Explicitly Authorized Raw Git Blob Hydration

**Scope:** populate the separately created metadata-only worktree from PR #10 using the inspected, pinned Git commit from PR #11. This is a local single-process capability, not a generic Git checkout, shell runner, Codex tool or workspace delete API.

## Enable locally

Both independent switches and a long random operator secret are required in ignored `apps/api/.env`:

```dotenv
DEV_HUB_REPOS_ROOT=F:\programer
DEV_HUB_ENABLE_WORKTREE_CREATION=true
DEV_HUB_ENABLE_WORKTREE_HYDRATION=true
DEV_HUB_WORKTREE_OPERATOR_SECRET=<your-random-32+-byte-secret>
```

Restart the NestJS server after changing configuration. **Do not commit the secret, expose the local API over a network, or paste the secret in a chat.** Existing plans and worktrees do not automatically hydrate.

## Workflow

1. Create a new Workspace session, preview a plan and acknowledge its fingerprint.
2. Separately authorize creation with the operator secret and create a real **metadata-only** Git worktree (PR #10).
3. Run **Перевірити готовність** on the read-only inspector (PR #11). It must return `ready-for-hydration`.
4. In the **Контрольоване наповнення worktree** panel, review the _exact path_, branch and pinned SHA. Tick explicit confirmation; re-enter the operator secret and choose **Окремо авторизувати наповнення**.
5. The API compares a timing-safe SHA-256 digest of the operator secret, verifies the plan and inspector result, and issues a **single-use 60-second grant**, bound to the session, plan, manifest fingerprint and Git commit.
6. Only a further deliberate **Записати Git-файли в worktree** click consumes that grant **before any async action**. The backend re-inspects the empty worktree, durably reserves the plan as `hydrationState=running`, then reads only exact raw Git blobs from the **pinned commit** with fixed `git ls-tree` and `git cat-file blob <OID>` commands.

The API validates the Git tree using the PR #11 scanner before writing. Limits: **5,000 files, 20 MiB per file, 100 MiB total**, no symlinks, submodules, special file modes, Windows invalid names/ADS, parent traversal, embedded NUL, path collisions or Unicode/case aliases. Only validated regular Git blobs may be copied. All file opens are **exclusive create-only**, with per-parent directory checks; a pre-existing file cannot be overwritten. Files are created mode `0600` where supported and are `fsync`ed before the file handle closes. The source repository working tree is not written.

After writing the verified blobs, hydration reconstructs the **disposable worktree’s Git index** from the exact pinned commit using fixed `git read-tree` plumbing and verifies there is no staged diff. This changes Git metadata only; it does not checkout files or touch the primary checkout. It allows subsequent one-file `git diff HEAD` review to see only actual changes instead of reporting the entire tree as staged deletions.

**This does not call `git checkout`, `git restore`, hooks, filters or smudge/clean commands**, so untrusted repo configuration cannot run checkout scripts through this API. The copied files may contain arbitrary user code but that code **is not executed**.

## Persistent recovery semantics

`WorktreePlan` gains optional fields `hydrationState: running | completed | failed`, `hydrationFiles`, and `hydrationBytes`. Older stored manifests continue loading. Audited events include `hydration-started`, `hydration-completed` and `hydration-failed`. Progress is persisted after each 25 written files; the terminal state records final totals.

A process interruption may leave partial files and `hydrationState=running`; a caught error marks it `failed`. Neither allows a replay, retry, overwriting, cleaning or deleting files through the API. Inspect the worktree manually and create a new plan only after reconciling Git metadata and files. **No destructive automatic cleanup is performed.**

The PR #11 empty-worktree inspector will report `needs-review` **after hydration**, because it deliberately detects nonempty worktrees. This is expected; use `hydrationState=completed` to distinguish successful materialization. A separate post-hydration integrity verifier is still needed before passing the worktree to an AI agent.

## Endpoints

All routes are restricted to their existing authenticated-by-operator-secret _action_ approval, and proxied only by the same-origin allowlisted Next.js Workspace route:

| Method | Suffix under `/workspace/sessions/:id/worktree-plans/:planId` | Purpose                                                                             |
| ------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| POST   | `/hydration-authorize`                                        | Body: `{"fingerprint":"sha256:...","operatorSecret":"..."}`, returns one-time grant |
| POST   | `/hydrate`                                                    | Body: `{"grantToken":"..."}`, consumes grant exactly once, writes only raw blobs    |

**Important limitation:** Dev Hub has no multi-user authentication; the operator secret is a local capability only. Its safety assumes the host account and local filesystem are trusted. Node.js pathname operations cannot provide a full adversarial race-free sandbox against a hostile local administrator rewriting directories between checks. **Do not use this on untrusted shared hosts or expose localhost ports publicly.** Docker worker/Codex and execution permissions remain disabled and disconnected.

## Validation

The API test suite creates disposable Git repositories containing text, binary bytes, and an intentionally configured smudge filter; it verifies byte-for-byte copies without invoking the filter, unique grants, disabled-by-default configuration, secret mismatch, TTL, changed target, state transitions, failure recovery and no writes into the source checkout. Both GitHub Linux CI and a dedicated Windows runner check these tests. The user's Home-PC remains unavailable for a direct local integration run; hosted Windows CI must not be presented as a local device test.

PR #14 adds [read-only post-hydration blob integrity verification](worktree-integrity.md) and a **non-executing mount preview**. Actual mounts, permission gates and Codex execution remain independent future steps. GitHub PR merging remains manual.
