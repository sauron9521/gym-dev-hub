# PR #26 — Real TypeScript 6 toolchain in isolated, offline Docker

This is the first demonstration of an **actually executed development tool** in the independent Gym Dev Hub. It deliberately executes the **real npm-published TypeScript compiler** (`typescript@6.0.3`) against two small, fully reviewed sample files inside a locked-down GitHub-hosted Linux Docker container. The source of `gym-platform` is **not mounted, compiled, edited, or executed**. This test never exposes a task-runner execution endpoint to Codex, the API, or the web app.

## Reviewed origin and exact compiler package

A separate, credential-free CI step checks out the known public `sauron9521/gym-platform` commit `73b636f5d064c7f24b43607e0c8411e9161f8986`. The previously reviewed `scripts/gym-platform-dependency-audit.mjs` checks the pinned commit's real lockfile and companion Git blob identities.

The real pnpm lockfile and the tiny fixture both contain exactly one resolution for:

| Property | Value |
| --- | --- |
| Package | `typescript@6.0.3` |
| SHA-512 integrity | `sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw==` |
| Node runtime | Node.js 24 / pnpm 12.18.0 |
| Platform | Linux CI, Alpine-based sandbox |
| Compiler runs | **One valid fixture succeeds; one intentional `TS2322` must fail** |

The TypeScript tarball is downloaded using `pnpm fetch --frozen-lockfile --ignore-scripts` in a **trusted, temporary networked CI step**, without Gym Platform secrets, database access, or shell commands from the package. The pnpm v12 project-index backlink is validated against its expected CI location and removed; generated `node_modules` in the host fixture is removed, and any remaining store symlink is rejected.

## A deliberately narrow, genuinely executable sandbox

The GitHub-hosted Linux Docker container runs a fixed CI-only Node entrypoint, `offline-typescript-smoke.mjs`. Before using `--trust-lockfile`, it verifies **each of the seven input fixture files** against its independently hardcoded Git blob SHA-1 and verifies the package's independently pinned SHA-512. It rejects unexpected source modifications or unsafe file types, examines the temporary pnpm store for symlinks and size/depth excesses, and copies the trusted store into a private `/workspace` tmpfs.

The script then runs these **static, non-user-configurable** operations:

```text
/bin/sh /usr/bin/devhub-pnpm install --offline --frozen-lockfile --ignore-scripts --trust-lockfile --store-dir /workspace/.pnpm-store
/usr/bin/node /workspace/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
/usr/bin/node /workspace/node_modules/typescript/bin/tsc --noEmit -p tsconfig.reject.json
```

The first TypeScript file must have zero diagnostics; the second intentionally assigns a `number` to a `string` and must produce **`TS2322`**. The root fixture includes intentionally forbidden lifecycle markers for `preinstall`, `install`, `postinstall`, and `prepare`; none may run. The lockfile must remain byte-identical.

**Docker restrictions**, checked against both requested HostConfig and observed mounts: nonroot UID 65534, `--network=none`, read-only rootfs, all capabilities dropped, no-new-privileges, `--ipc=none`, max 2 CPUs/2 GiB RAM/128 PIDs, no Docker socket, no source repository, and only two read-only host binds (`/input`, `/store`) plus two private noexec tmpfs directories (`/workspace`, `/tmp`). A noexec mount prevents direct ELF execution from the directory but **does not prevent Node from interpreting installed JavaScript code**. The compiler is executed intentionally and should be treated as third-party code in a sandbox.

CI enforces a 90-second install and 45-second maximum per compiler invocation, with bounded output and cleanup. Negative container probes must reject a changed fixture file and an empty offline store.

## Security interpretation

- **Real achievement:** a pinned third-party compiler is installed, executed, and tested in networkless Docker against reviewed fixture source, without root/host secrets and without running dependency lifecycle hooks.
- **Not yet implemented:** install of all Gym Platform packages; native binaries, Prisma generators, monorepo imports, access to Gym Platform source, a Windows Docker Desktop test on Home-PC, or any operator-approved real application `typecheck`/`lint` recipe.
- **Important limitation:** lockfile integrity and Git blob IDs establish correspondence with reviewed data, not the reputation or security of the TypeScript upstream publisher. Docker and package managers are not mathematical isolation proofs. This CI workflow uses a temporary store, not a cryptographically attested shared cache.
- **Still prohibited:** taking user-supplied shell commands, mounting secrets, executing Codex-supplied code, changing target source, pushing a PR automatically or merging without the owner. The standard `runner.mjs` entrypoint remains `HELLO/PING/TOOLCHAIN/SHUTDOWN` only.

## Next safe step

Build a reviewed real Gym Platform **read-only source snapshot** with a private output overlay and an explicit, single-use operator authorization bound to the specific worktree commit/fingerprint and recipe. Add bounded logs and reliable container cleanup before any actual Gym Platform compiler run. Native dependency provisioning should remain a separate reviewed design.

Always review both the new Docker smoke workflow and the ordinary CI **on the final PR head SHA**. No auto-merge.
