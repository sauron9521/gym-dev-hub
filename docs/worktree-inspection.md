# Worktree Checkout Safety Inspection and Read-only Recovery (PR #11)

**This is a safety preflight only. It does not hydrate/check out files, remove Git metadata, run commands from a repository or grant agent permissions.**

PR #10 introduced an opt-in, metadata-only Git worktree. Before safely copying project files into such a worktree, the API must check what would be copied and whether the Git registration still matches the intended repository and base commit. An interrupted `creating` or `failed` plan needs a **read-only** recovery view rather than blind deletion.

## Using the inspector

In `/workspace`, select a session with a plan in `creating`, `created`, or `failed` state and click **Перевірити готовність**.

The inspector does not mutate the source repository or target worktree. It returns:

- `ready-for-hydration`: only when the manifest is `created`, the target folder contains *only* its `.git` pointer and all checks pass
- `needs-review`: the target exists but has unexpected content, incorrect Git metadata, unsafe tree objects, a failed/interrupted plan or another mismatch
- `missing`: the target directory cannot be found or verified

It verifies the allowed local source clone and GitHub origin, target containment within the configured worktree root, real (non-symlinked) directories, the worktree's shared Git metadata location, expected branch and exact `baseHeadSha`. It checks the base commit's tree with **read-only** `git ls-tree -r -l -z`, not checkout, Git filters or user-supplied shell scripts.

The tree scan blocks symlinks (`120000`), submodules (`160000`), special file modes, `.git` path segments, parent traversal, Windows reserved names / alternate data streams, invalid separators, Unicode/case collisions, and size limits. Initial limits are **5000 files, 20 MiB per file, and 100 MiB total**. These are conservative first-slice defaults; a larger worktree may report `needs-review` until limits are explicitly reviewed.

## API

```http
GET /workspace/sessions/:sessionId/worktree-plans/:planId/inspection
```

Via Next.js:

```http
GET /api/workspace/sessions/:sessionId/worktree-plans/:planId/inspection
```

The endpoint requires a valid session and plan ID, is strictly allowlisted in the Next.js proxy and accepts **no command or path arguments**. Output is summary metadata and human-readable warnings, never file contents, tokens or raw Git stderr. All local Git subprocesses use `execFile` with `shell: false`, read-only commands, disabled hooks/fsmonitor, no prompts or automatic lazy fetching, bounded output and timeouts.

**Important:** The state `ready-for-hydration` is not an execution permit. The response always has `hydrationEnabled: false` and `recoveryIsReadOnly: true`. It is a point-in-time preflight, and future write operations must revalidate all conditions immediately before acting.

## Recovery policy

When the API crashed during worktree creation or a previous Git operation failed, the inspector can show whether the metadata-only target exists, whether it is unexpectedly populated and whether it still matches the intended Git commit. It deliberately **does not automatically run** `git worktree prune/remove`, delete a branch, overwrite target files, hydrate data or retry a failed plan.

Any manual cleanup should start with `git -C <source> worktree list` and `git -C <source> branch --list 'devhub/task-*'`; review actual local changes before removing anything.

## Testing and future slices

Pure tree-validation tests cover unsafe names, symlinks, submodules, size bounds and collisions. Integration tests use **temporary Git repositories and metadata-only worktrees**, verify the expected branch and commit, and prove that inspection preserves files and source state. GitHub Actions runs these tests on its Linux runner. **The Windows Home-PC was unavailable during implementation, so the actual Windows integration check remains outstanding**; do not treat CI as a substitute for it.

Next PR: after the Windows checks are complete, add a separately approved, bounded materializer that copies **raw Git blobs**, never executes checkout filters, and records recoverable progress. Do not wire in Codex, Docker mounts or arbitrary shell execution until that materializer has independent verification.
