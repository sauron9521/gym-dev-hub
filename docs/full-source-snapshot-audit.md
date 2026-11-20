# PR #28 — Full immutable Gym Platform tracked-source snapshot

This is a standalone **CI-only** proof that Gym Dev Hub can safely mount and verify the **entire tracked source tree** of one reviewed Gym Platform commit, _without_ mounting the source repository's Git metadata, any untracked files, environment secrets or private local worktree state.

It **does not** allow any caller to execute project code, build Gym Platform, run tests, or request a new permission grant. The normal diagnostic `runner.mjs` remains non-executing, and no NestJS or web execution endpoint is added.

## Exact source snapshot

The trusted GitHub Actions workflow checks out public `sauron9521/gym-platform` at immutable commit:

```text
commit 7104f723c4ee7b81e7b9b64e9c9483aea344ef7a
tree   2c140e1e740b3dd8cc7582db726f46b54b73b334
```

The known reviewed tree contains **1,258 tracked Git blobs**, totaling **6,241,392 bytes** (approximately 6.2 MB), including exactly one executable-mode file, with no symlink or gitlink entries. The source tree is small enough for the initial bounded proof. This is a **point-in-time source snapshot**, not a claim about future `main` commits.

The CI runner uses a pinned-commit checkout, checks the exact commit/tree IDs, and generates a **NUL-delimited canonical manifest** via `git ls-tree -r --long -z HEAD`. It verifies file modes, total count and byte size before exporting `git archive HEAD` into a disposable source directory. The exporter excludes `.git` and untracked files by construction and rejects any symlinks. The commit checkout and archive happen in the **trusted CI phase**, not inside the isolated container.

To avoid accepting an attacker-controlled manifest as its own trust authority, the manifest's **SHA-256 digest is independently pinned inside the reviewed Docker image**. That pin must be explicitly updated when upgrading the approved Gym Platform commit; it cannot come from a web request, browser, agent message, working tree, or editable manifest input. The repository commit and Git tree identifiers are also pinned in the CI workflow and image script. A pinned Git SHA-1 tree identifies reviewed Git contents; it is not a cryptographic package signature or a replacement for repository access controls.

## Networkless read-only verification

`packages/runner/full-source-audit.mjs` is a fixed, argument-free, CI-only entrypoint copied into the runner image. In Docker it receives **only two read-only bind mounts**, `/source` (archive of exactly the 1,258 tracked source files) and `/manifest` (the independently pinned manifest). It:

- Rejects an unsafe manifest, wrong SHA-256, unsupported entry mode/type, repeated or traversal paths, unexpected file count/size or executable-mode drift.
- Walks the _entire_ mounted source directory and rejects extra, missing, symlink, non-regular or hardlinked files, excessive directory nesting and unexpectedly executable files.
- Verifies each file's Git blob SHA-1 against the canonical reviewed manifest, plus exact file sizes and executable-mode information.
- Emits a bounded structured JSON summary with the pinned commit/tree and **no execution granted**.

Docker's enforced policy is nonroot UID/GID `65534:65534`, `--network=none`, read-only rootfs, `--cap-drop=ALL`, no-new-privileges, `--ipc=none`, 512 MiB RAM, 1 CPU, 128 PIDs, a private noexec `/tmp` tmpfs and no Docker socket, app secrets or writable source mounts. CI validates both requested HostConfig and actual read-only mount identities, checks exit code and output, and deletes the disposable container. The verifier **never** launches `pnpm`, `tsc`, a shell process, or any Gym Platform application script.

Negative tests in the **same isolated Docker policy** must reject five cases: modified source bytes, an extra untracked file, a symlink replacing a tracked file, a missing tracked file, and a modified manifest.

## Important limitations

This snapshot covers **Git-tracked files only**. It does not include untracked, ignored or generated assets in a developer's local worktree; it does not run `git checkout` or change local branches, access a developer's Windows machine, install native modules, or hydrate node_modules. Source files may contain checked-in examples or policies, but no user secrets or `.git` folder are mounted.

This is a **read-only data-integrity proof, not a sandbox for executing arbitrary source**. It does not yet create a private writable dependency overlay, a one-time execution approval, a fixed `API_TYPECHECK` launcher, audit-log integration, or CI feedback into PR editing. An image containing the CI-only verifier is _not_ equivalent to making it callable through the product API.

The next recommended small PR is a **single-use, recipe-specific operator authorization policy** bound to the immutable source manifest and task/worktree identity. Then add a separately reviewed, disposable writable overlay and a limited, time-bounded, non-networked real-project check with the required pinned toolchain and native dependencies. All GitHub merges remain manual; Windows Docker Desktop still needs separate validation.
