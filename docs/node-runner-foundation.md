# PR #20 — Isolated Node.js + pnpm Runner Foundation

This PR adds a **separate, non-executing** image for future gym-platform test checks. It does not change the existing Alpine worker, does not launch a runner from the API or dashboard, and **never runs repository scripts**.

## Toolchain and build

- New `packages/runner/Dockerfile`, built from the same explicitly pinned Alpine 3.23 base digest used by the fixed worker.
- Installs Node.js **major 24** from Alpine 3.23 packages. Fails the build if the installed major is different.
- Installs **pnpm 12.18.0**, an exact version matching gym-platform, with `npm install --global --ignore-scripts --no-audit --no-fund`. The build fails if the installed version is different.
- Network access is required **only for the trusted image build** (Alpine and npm registries). No user-provided package or repository source is included in the Docker context, and the build never runs package lifecycle scripts.
- The base image digest is pinned, but Alpine package indexes and npm registry distribution content are external build dependencies. This is **not a completely reproducible offline build**. Further hardening should pin dependency artifacts/integrity and maintain an update/security-review process.

Run from the root of `gym-dev-hub`:

```sh
docker build --pull=false --tag gym-dev-hub-node-runner:v1 --file packages/runner/Dockerfile packages/runner
```

The image includes Node/pnpm binaries but has only one fixed runtime entrypoint, `/usr/bin/node /opt/gym-dev-hub/runner.mjs`. CI verifies that the actual image user is UID:GID `65534:65534`, the labels and entrypoint are exact, and Node/pnpm versions match.

## Protocol: diagnostic only

Only four newline-delimited messages are accepted: `HELLO/1`, `PING/1`, `TOOLCHAIN/1`, `SHUTDOWN/1`. Replies are bounded, structured JSON with `executionEnabled=false`. The toolchain response contains Node major version and pinned pnpm version but **does not execute pnpm**. `RUN`, `INSTALL`, `TEST`, arbitrary shell text and all other inputs are explicitly rejected.

There is deliberately **no API route, service launcher, user approval token, host mount or persistent job** to run this image. The `task-preview` endpoint from PR #19 continues to return `runnerImageAvailable=false` and `executionEnabled=false`; successfully building the image does not grant execution.

## Proposed fixed Docker isolation

`diagnosticRunnerArguments` in `apps/api/src/runner/runner-policy.ts` is a **pure policy builder** for a future reviewed launcher. It validates a random UUID-scoped container name and exact `sha256:<image-id>`, never accepts free-form flags, and emits:

- Local immutable image ID with `--pull=never`, `--rm`, fixed entrypoint, no user-supplied CMD/args.
- `--network=none`, no `--mount` or volumes, no Docker socket, no inherited secrets.
- Non-root `65534:65534`, read-only root, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--ipc=none`.
- `--pids-limit=128`, `--memory=2048m`, `--cpus=2`, `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777`, `--stop-timeout=3`.

**Important:** A shell inside the image is not proof of safe project-script execution. No `pnpm test`, install, Prisma generate or script code may run until there is a separately approved read-only snapshot or overlay model, vetted dependency provisioning, actual runtime isolation inspection, deadline/output bounds, and a single-use operator grant.

## CI

`.github/workflows/node-runner-image.yml` builds the actual image and checks installed runtime binaries. It starts a real container with all proposed flags and inspects the observed Docker state: no mounts, no network, no privileged capabilities, read-only root, non-root UID, CPU/memory/PID limits and cleanup. It exercises the fixed protocol, rejects two arbitrary command attempts and checks that no container persists.

The Linux hosted runner validates Linux Docker behaviour only; **Windows Docker Desktop** and Home-PC specifics still need local verification. Do not expose `localhost` API/UI to other machines without authenticated access.

## Next steps

1. Secure, pinned dependency provisioning strategy that prevents lifecycle-script surprises and explicitly handles packages needing native binaries or databases.
2. Disposable read-only project snapshot + non-shared writable overlay/tmpfs for generated files, validated for Docker Desktop and non-root mounts.
3. Independent one-time operator permission for one of the six recipes in PR #19 and a fresh Git commit/fingerprint verification.
4. Separate constrained runner entrypoint implementing only approved `pnpm` recipes, streamed bounded output, hard timeout, reliable container teardown, and **manual review/merge**.

The existing Docker worker and PR #19 preview are untouched; arbitrary command execution is still unavailable.
