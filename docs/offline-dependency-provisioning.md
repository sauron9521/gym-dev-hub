# PR #21 — Offline pnpm dependency provisioning proof

This PR implements the first **real** dependency provisioning experiment in Gym Dev Hub, deliberately restricted to a harmless, reviewed fixture. It does **not** install dependencies or run tests for `gym-platform`, and introduces **no application endpoint or new authorizations**.

## Why this is separate from running tests

The production `gym-platform` mono-repository currently uses `pnpm@12.18.0`, a lockfile with `lockfileVersion: '9.0'`, and `pnpm-workspace.yaml` with `nodeLinker: hoisted`. Its build policy permits some lifecycle steps for `@prisma/engines`, `prisma`, `bcrypt`, `esbuild`, and `@swc/core`, among others. Running dependency installation or package scripts directly on the host or within the read-only worker is **not an acceptable first step**. A script-free install may not produce usable Prisma or native binaries.

## What the proof actually executes

1. Builds the dedicated Node 24 / pnpm 12.18.0 toolchain image from PR #20, adding a **CI-only** `offline-provision.mjs` (normal worker entrypoint stays `runner.mjs`, with `RUN` and `INSTALL` still rejected).
2. Starts a disposable Docker container (in CI only) with the **checked-in four-file local fixture** as its only read-only bind mount under `/input`; `/workspace` is disposable writable tmpfs. No host workspace, project source, credentials, Docker socket, or network are mounted or exposed.
3. Validates regular non-symlink fixture inputs, strict paths, total byte bounds, the expected fixture package names, `pnpm@12.18.0`, workspace dependency and lockfile version 9.
4. Copies only those four files into `/workspace`, exclusively creating each staged file. Executes the *fixed, non-user-configurable* argv:
   ```text
   /usr/bin/pnpm install --offline --frozen-lockfile --ignore-scripts
   ```
   with `shell:false`, a minimal environment, the Docker network disabled, and a fixed timeout / output cap.
5. Confirms one local workspace package was installed/linked, the staged lockfile hash is unchanged, and both deliberately hostile root and package lifecycle hooks **did not execute**.
6. Runs a negative case with an altered lockfile: the container rejects it rather than falling back to fetching/installing packages.
7. Asserts Docker constraints and cleans up both containers. CI executes on Linux Docker only; Home-PC Docker Desktop remains unverified.

### Runtime restrictions in fixture CI

| Attribute | Fixture proof |
| --- | --- |
| Network | `none` |
| Root filesystem | Read-only |
| UID/GID | `65534:65534` |
| Capabilities | Dropped (`ALL`) |
| Docker socket | Not mounted |
| Input mount | One *reviewed fixture*, read-only |
| Output | Ephemeral `/workspace` tmpfs, `noexec` |
| Memory / CPU / PIDs | 2 GiB / 2 / 128 |
| pnpm | Offline, frozen lockfile, ignore scripts |
| Timeout | 30 seconds for pnpm |
| Output cap | 8 KiB for captured pnpm output |
| Real project | **Not mounted, not installed, not run** |

## Explicit gaps for actual Gym Platform

- **Dependency resolution and artifact integrity:** The fixture uses only a `workspace:*` local link. Real transitive npm packages, engine binaries, private registries and cache population have **not** been tested. Offline availability does not prove package trust; a future cache must be content-addressed, integrity-checked and built in a separately reviewed, trusted stage.
- **Native/build outputs:** Real `gym-platform` includes Prisma engines, `bcrypt`, `esbuild`, SWC and other packages requiring approved builds. With `--ignore-scripts`, these may be incomplete. Never silently run those scripts or treat this fixture proof as a green project readiness check.
- **Untrusted configuration and hooks:** Real `pnpm-workspace.yaml`, `.pnpmfile.cjs`, `file:` dependencies and package managers can run project-controlled code. A future input manifest review must explicitly reject unsafe hooks and dependencies and provision source/assets in separate mounts or a disposable overlay.
- **Safe runtime commands:** The future runner requires a pinned dependency snapshot and separate one-time operator consent per PR #19 recipe, more real Docker Desktop checks, bounded logs/deadline, independent error handling and manual PR review/merge.
- **Toolchain distribution:** The Docker base digest is pinned, but Alpine/npm package artifacts are not yet fully pinned by hash. A reproducible offline image build requires further work.

This PR does not modify `gym-platform`, use privileged host access, launch Codex, create PRs from agents or enable auto-merge.

## Reproducible verification

GitHub Actions: **Offline pnpm Provisioning (fixture only)** and the existing **Node Runner Image** and **CI** workflows. Confirm each passes on the final PR head SHA before manually merging.
