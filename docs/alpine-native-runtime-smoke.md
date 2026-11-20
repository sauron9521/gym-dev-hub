# PR #36 — Fixed Alpine native runtime smoke (CI only)

This is a **limited intentional execution proof**, not a general Gym Platform runner. It follows the completed PR #35: all four expected ELF64/x86_64 headers were found offline, but header inspection did not establish dynamic loader/runtime compatibility.

## Fixed scope

The existing CI workflow still pins Gym Platform commit 7104f723c4ee7b81e7b9b64e9c9483aea344ef7a and its immutable Git tree/1,258-file manifest, pnpm lock and SHA-512-resolved dependency artifacts. It uses a reviewed Alpine 3.23 / Node 24 image, and a separate trusted, credential-free CI network stage to fetch dependencies. No dependency lifecycle scripts are allowed.

The additional **CI-only** script:

1. Rejects absent, noexec or reused /native scratch before provisioning.
2. Runs the reviewed offline dependency verifier with read-only /source, /manifest and /store and **noexec** /workspace.
3. Checks the pinned Prisma schema-engine SHA-256 and all four static native ELF64/x86_64 headers.
4. Copies only eight reviewed native package directories (bcrypt, node-gyp-build, sharp, both @img musl packages, @img/colour, detect-libc, semver) into a **new 256 MB isolated exec tmpfs** at /native. It rejects symlinks, special files and over-budget trees; package metadata is checked.
5. Runs a fixed Node fixture under a 30-second bound: bcrypt hash/compare against fixed non-secret strings, and a 2×3 PNG buffer roundtrip via sharp/libvips.
6. Runs **only** the pinned Prisma schema-engine with the fixed argument --version, bounded to 20 seconds; no Prisma DB connection.
7. Reports a small JSON event with explicit guarantees that API_TYPECHECK, app scripts, arbitrary task execution and operator grants remained disabled.

The container has no network, no credentials, no Docker socket, no privileged operations, no Linux capabilities, UID/GID 65534, resource and PID limits, and a read-only root. Only the reviewed /native tmpfs permits executable mappings; /workspace, /results and /tmp remain noexec. The immutable source is never made writable. GitHub Actions verifies the exact Docker HostConfig and mount destinations, tests rejection of a missing/noexec /native mount, and removes the container.

## Boundaries and next step

The test proves that these **specific pinned binaries and dependencies** can be loaded in this specific isolated Alpine image for tiny fixed operations. It does not certify arbitrary image inputs, real user code, production infrastructure, connectivity to PostgreSQL, full NestJS boot, TypeScript API typecheck, or agent-triggered task execution.

The regular runner.mjs protocol stays non-executing. No HTTP endpoint is enabled; the operator grant path remains unchanged and no GitHub merge is automated.

A future separately reviewed PR can prepare the fixed API_TYPECHECK recipe with one-use authorization, exact source/task pins, bounded diagnostics and strict cleanup, without broadening this CI-only proof.
