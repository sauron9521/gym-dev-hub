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
