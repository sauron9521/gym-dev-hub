# Isolated Node / pnpm Runner Foundation

**PR #20 introduces an image and a fixed, diagnostic protocol only.**

- Runtime: Node.js 24 from Alpine v3.23, pnpm 12.18.0.
- Build-time networking is needed for Alpine packages and global pnpm installation. No `pnpm install`, project code, or project lifecycle script is run at build time.
- Runtime: fixed `HELLO/1`, `PING/1`, `TOOLCHAIN/1`, `SHUTDOWN/1` only. All other input (including `RUN`, `TEST`, and `INSTALL`) is rejected.
- The image does not contain or mount gym-platform source. No network, host mounts, credentials, Docker socket or privileged user may be supplied in the **future** launch.
- CI verifies both installed binaries and Docker security flags.

Build locally with Docker Desktop (build requires network access):

```sh
docker build --pull=false --tag gym-dev-hub-node-runner:v1 --file packages/runner/Dockerfile packages/runner
```

The image is **not** invoked by the web app or the API. A future, separately reviewed PR must add an explicit opt-in and permission gates before any execution. No Docker worker policy is loosened here.

See `docs/node-runner-foundation.md` for the security/rollout plan.

## Offline package provisioning proof (PR #21)

The separate `offline-provision.mjs` is a **CI-only fixed fixture** command. It is unreachable via the normal `runner.mjs` protocol. A dedicated workflow runs `pnpm install --offline --frozen-lockfile --ignore-scripts` against a tiny, reviewed, local-only workspace, with a read-only fixture input and ephemeral tmpfs output, no network, non-root UID and resource limits. Malicious fixture lifecycle scripts must **not** run.

This is **not** a way to install `gym-platform` packages yet. Its actual Prisma/native dependency builds require a separately approved isolated build strategy. There is no API endpoint, package download at runtime or task-execution permission in this PR.

## Content-addressed cache integrity proof (PR #22)

The dedicated `cache-verify.mjs` is a **CI-only** tool. It validates a reviewed, tiny npm tarball against an **independent image-pinned SHA-512 SRI**, not merely the untrusted input manifest. It stages the verified compressed archive under its SHA-512 digest in an ephemeral, non-executable tmpfs, re-reads and compares it, and rejects a modified archive, a forged manifest, and symlink inputs. It **never** extracts the archive, runs package hooks, installs external packages, or mounts `gym-platform`.

The normal `runner.mjs` protocol still rejects arbitrary execution. See `docs/dependency-cache-integrity.md` for the trust model, tests and real-dependency limitations.

## One real pinned npm artifact (PR #24)

GitHub Actions fetches **one exact public `is-number@7.0.0` tarball** from npm's HTTPS registry in a separate, credential-free networked CI step, first confirms that the source `gym-platform` lockfile matches a reviewed Git commit/blob and the independently pinned SHA-512 SRI, and then gives only the verified tarball to a `--network=none`, non-root, read-only Docker container. The CI-only `real-artifact-verify.mjs` revalidates the SRI and stages compressed bytes in an ephemeral noexec, content-addressed `/cache` tmpfs. Modified bytes and symlink inputs are rejected. The archive is **not extracted or installed** and no project script executes; see `docs/real-npm-artifact-provenance.md`.

## Two real pinned npm packages, installed fully offline (PR #25)

A standalone, CI-only `offline-real-pair.mjs` demonstrates `pnpm fetch` of exactly two reviewed real npm packages (`to-regex-range@5.0.1` and transitive `is-number@7.0.0`) in a credential-free trusted CI step, followed by a **frozen, offline, script-free** installation inside an isolated Docker container. The pnpm store and the three-file fixture are read-only host inputs; everything written by pnpm is in an ephemeral noexec tmpfs. The installed dependency graph is checked using package metadata only, without importing the packages. No native builds, code execution, real Gym Platform source or permanent package cache are added. See `docs/real-offline-dependency-install.md`.

## Real TypeScript 6 toolchain smoke (PR #26)

The CI-only `offline-typescript-smoke.mjs` installs the **real `typescript@6.0.3`** from a checked, read-only, temporary store inside a networkless Docker container, then executes the compiler on exactly two reviewed, tiny TypeScript fixtures: one must typecheck and one must fail with `TS2322`. This deliberately executes npm-published TypeScript compiler code **inside CI Docker only**, not any Gym Platform code. Inputs are individually Git-blob-pinned, the installer remains `--offline --frozen-lockfile --ignore-scripts --trust-lockfile` and the diagnostic `runner.mjs` API remains non-executing. See `docs/typescript-toolchain-smoke.md`.

## First pinned Gym Platform source typecheck (PR #27)

A separate **CI-only** entrypoint `pinned-source-typecheck.mjs` checks the actual source code of four small, import-free TypeScript modules from the immutable Gym Platform Git commit `73b636f5d064c7f24b43607e0c8411e9161f8986`. Each file is copied from the reviewed commit to a disposable **read-only host snapshot**, rehashed against an independent Git blob pin inside networkless Docker, and typechecked with real `typescript@6.0.3` installed offline in a private tmpfs. It never runs Gym Platform scripts, imports/evaluates the source, mounts the full monorepo, or exposes execution to API/Codex. The ordinary `runner.mjs` remains diagnostic-only. See `docs/pinned-gym-platform-source-typecheck.md`.

## Immutable full tracked-source snapshot audit (PR #28)

A **CI-only** entrypoint, `full-source-audit.mjs`, verifies **every one of the 1,258 Git-tracked files** (6,241,392 bytes) from the specifically reviewed Gym Platform commit `7104f723c4ee7b81e7b9b64e9c9483aea344ef7a`. CI first exports an archive **without `.git` or untracked local files**, generates Git's NUL-delimited tree manifest, and mounts **only** that source snapshot and its independent manifest read-only into a nonroot, network-disabled, read-only Docker container. The image pins the manifest SHA-256 and checks each file's Git blob, size, mode, path, and absence of unexpected files/symlinks. No Gym Platform commands run; `runner.mjs` still forbids arbitrary execution. See `docs/full-source-snapshot-audit.md`.

## Separate temporary scratch volumes for future execution (PR #30)

The CI-only `overlay-preflight.mjs` first verifies the entire immutable Gym Platform source tree via the reviewed `full-source-audit.mjs` code, then validates two **independent noexec tmpfs** mounts: `/workspace` for transient dependencies, cache and generated files, and `/results` for ephemeral diagnostics. It never writes to the read-only `/source` or `/manifest` Git mounts, never installs packages or launches Gym Platform scripts, and neither the ordinary runner protocol nor the API can invoke it. Two clean container instances prove that outputs are not shared; negative probes reject missing/unsafe mounts and tampered source/manifest. This is a private scratch-volume _foundation_, not a working overlayfs/union filesystem and not task execution. See `docs/private-overlay-preflight.md`.

## Real API dependency closure smoke (PR #32)

The CI-only `offline-api-cache.mjs` verifies a complete pinned Gym Platform source snapshot, accepts a temporary read-only pnpm cache from a credential-free trusted CI stage, copies both to a **private tmpfs**, and attempts an offline, frozen, script-free `@gym/api` dependency installation. This is a real target dependency installation, not a small two-package fixture, but **no Prisma generation, API typecheck, project scripts, or other code from Gym Platform is invoked**. The usual `runner.mjs` protocol remains non-executing. See `docs/real-api-dependency-cache.md`.

## Private Prisma 7 client generation proof (PR #33)

The CI-only `prisma-native-preflight.mjs` invokes the already reviewed, **script-free offline API dependency rehydration** on one immutable Gym Platform Git snapshot, then intentionally executes a **single fixed pinned Prisma CLI** in the disposable, offline, nonroot Docker container. Client files are written to the _private copied project_ under `/workspace/project/apps/api/src/infra/database/generated/prisma`; the public source bind remains read-only and unchanged. The standard runner protocol, Hub API and Codex cannot call the proof. Native engine/prebuilt runtime suitability is not established by generating Prisma code; see `docs/private-prisma-native-preflight.md`.

## Static musl native binary inventory (PR #34)

The separate CI-only `native-compatibility-preflight.mjs` rehydrates the verified API dependency cache offline and inspects **only ELF file headers**, without loading Prisma engines, `bcrypt`, `sharp` or libvips. It records whether matching Alpine/musl x86_64 candidates are absent, and never claims runtime readiness from a matching header. The Hub API, operator grants and regular runner remain non-executing. See `docs/native-binary-static-audit.md` for negative tests and the remaining dynamic-link/runtime gate.

## Exact Alpine-musl optional dependency provisioning (PR #35)

The trusted GitHub Actions stage validates independently reviewed lockfile SHA-512 records for sharp 0.35.5 and libvips 1.3.4 musl x64 optional packages, then temporarily configures pnpm to fetch both linux-x64 (glibc) and linux-x64-musl packages with scripts disabled. The original pinned workspace config is restored before source cleanliness checks. The isolated Docker static inventory now **fails if either musl binary is missing**.

This still never loads or executes native packages and does not expose API_TYPECHECK or arbitrary commands. Native runtime compatibility remains gated behind an independent, narrowly scoped follow-up.

## CI-only Alpine native runtime smoke (PR #36)

The separate native-runtime-smoke.mjs fixed entrypoint checks the real pinned offline API graph, validates all four native ELF artifacts, copies **only reviewed native package directories** from the private noexec project to a dedicated executable /native tmpfs, then intentionally loads bcrypt and sharp to run tiny fixed fixtures and probes the pinned Prisma schema engine. The original source, /workspace, /results and /tmp remain protected. An unsafe or missing executable scratch mount fails before install; execution is networkless, non-root and bounded.

This is **not** general task execution or API_TYPECHECK. The default runner protocol and Hub HTTP endpoints remain unchanged. See docs/alpine-native-runtime-smoke.md for boundaries and controls.
