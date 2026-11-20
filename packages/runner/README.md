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
