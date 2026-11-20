# PR #27 — First TypeScript check of real Gym Platform source in isolated CI

This PR moves beyond PR #26's **synthetic TypeScript samples** to compile **four actual, unchanged TypeScript files** from `sauron9521/gym-platform` at an independently pinned Git commit. The full Gym Platform workspace is still **not typechecked**. No app code is executed at runtime, and this is **not** a general Codex/API/UI execution capability.

## Immutable four-file snapshot

The trusted GitHub Actions job checks out the public repository at exactly `73b636f5d064c7f24b43607e0c8411e9161f8986` with no persisted Git credentials. The existing PR #23 audit validates the commit's five pinned dependency metadata blobs, including its actual `pnpm-lock.yaml`. The workflow checks each selected file against the commit's Git tree, copies **only** those four files into a disposable directory and rehashes the copies:

| File from Gym Platform | Reviewed Git blob |
| --- | --- |
| `packages/domain/src/index.ts` | `4bfb3dd4455f6612eb818ad694ccbb7e56f743ce` |
| `packages/i18n/src/locales.ts` | `acdfbb8e07aa031e8ac0ca05e8d3fb6026ffc77a` |
| `apps/api/src/modules/workout-analytics/utils/workout-analytics-window.ts` | `cab78200f48bfe265ff374df9eebe4fd3902684e` |
| `apps/mobile/src/features/exercises/lib/exercises-pagination.ts` | `bc1a7817f2cfcf0f6bf3672502d0212cb843b276` |

These modules have **no imports** and can be checked without the rest of Gym Platform's dependency tree. The CI makes a flat, four-file snapshot (renaming each file to a deterministic unique basename) and verifies its exact file count and absence of symlinks before giving Docker a **read-only** mount. The entire repository, `.git`, environment files and credentials are not mounted.

Inside Docker, the CI-only `packages/runner/pinned-source-typecheck.mjs` again checks that the mount contains exactly those four regular files, no unexpected entries and the **hardcoded Git blob hash** of each source file before copying the verified bytes to a separate private tmpfs. Neither file paths nor commands are supplied by the browser.

## Real TypeScript, offline

The independently pinned real `typescript@6.0.3` SRI is confirmed in the trusted Gym Platform lockfile and the dedicated TypeScript fixture's mini lockfile. A separate, credential-free CI stage populates an ephemeral pnpm store. The known pnpm 12 bookkeeping backlink is removed only after checking its target; all other store symlinks are rejected.

The Docker verifier independently validates three exact toolchain fixture Git object hashes and its TypeScript SRI, copies the fixed fixture and bounded cache into `/workspace`, and executes only:

```text
/bin/sh /usr/bin/devhub-pnpm install --offline --frozen-lockfile --ignore-scripts --trust-lockfile --store-dir /workspace/.pnpm-store
/usr/bin/node /workspace/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

The generated `tsconfig.json` is reviewed code inside the CI-only verifier: `strict`, `ES2022`, `ESNext`, `Bundler` module resolution, `noEmit`, `types: []`. It includes exactly the four approved source snapshots; no caller can change compiler arguments or add arbitrary file paths. The compiler **parses/typechecks** Gym Platform code, but does not import/evaluate it as executable JavaScript, run its `package.json` scripts or launch NestJS, Next.js, Expo or Prisma.

**`--trust-lockfile` is permitted here only after hardcoded hashes independently validate all three reviewed mini-fixture files and the TypeScript SRI.** It must not be used with an agent-controlled lockfile. It prevents pnpm 12's redundant online policy lookup; npm package integrity remains checked by pnpm and the immutable SRI pins.

## Isolation and negative cases

The real Linux Docker run is inspected to ensure:

- `--network=none`, read-only root filesystem, `--cap-drop=ALL`, no-new-privileges and `--ipc=none`
- UID/GID `65534:65534`, 2 GiB RAM, 2 CPUs, 128 PIDs
- Exactly three **read-only** mounts: the four-file source snapshot at `/input`, reviewed toolchain fixture at `/fixture`, and temporary package store at `/store`
- Two private `noexec` tmpfs mounts (`/workspace`, `/tmp`), no Docker socket, no Git repository mount, no registry tokens
- Bounded pnpm/tsc subprocess time and outputs, frozen lock hash, no lifecycle-script markers, and container deletion

Three negative Docker runs **must fail closed**: a changed source file, an injected source symlink, and an empty dependency store. The trusted CI copies and deletes all temporary files; no Gym Platform file is edited.

A `noexec` filesystem does not prevent interpreted JavaScript execution: **the third-party TypeScript compiler itself executes intentionally inside Docker**, while the target's TypeScript source is analyzed but not run.

## Limitations and next increment

This is **a typecheck of four reviewed, dependency-free files, not a production `pnpm --filter @gym/api typecheck`**. It does not prove the target's full build or native dependencies, local Windows Docker Desktop compatibility, TS project references, generated Prisma modules, database access, safe execution of arbitrary user-edited code, container escape resistance or package publisher trust. Git SHA-1 identifies pinned source blobs and is not a package authenticity signature.

The Hub's ordinary runner protocol stays non-executing, its `task-preview` stays non-executing, and no operator approval or task execution route is exposed in this PR. The next work should explicitly scope immutable **full-worktree** snapshots and writable private dependency overlays, then independently reviewed, single-use operator grants for one of the six fixed actual Gym Platform checks. All PR merges remain manual.

Review the new Docker check and main CI **on the exact final PR commit** before merging.
