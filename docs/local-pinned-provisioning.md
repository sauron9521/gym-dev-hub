# Local pinned API_TYPECHECK provisioning (#55)

PR #54 added a disabled-by-default operator-approved execution endpoint but required four trusted offline input directories and a pinned runner image. This step supplies an **explicit, manual CLI** that stages and verifies those prerequisites, end to end, without using your existing Gym Platform checkout or modifying the Hub's execution flags.

## Run on Windows or Linux with local Linux Docker

Requirements: Node.js 24, a local `tar` executable (built into modern Windows and standard on Linux), Docker Engine in local Linux/amd64 mode, 5 GiB of Docker memory available, several GiB of temporary Docker RAM/disk, a writable checkout of this Hub repository, and network connectivity to GitHub, the npm registry, Alpine repositories and Prisma's official binary CDN. The script may download a substantial pinned dependency graph; allow adequate free disk space.

From a clean checkout of the reviewed Hub revision:

```sh
pnpm provision:pinned-api
# Equivalent: node scripts/provision-pinned-api-local.mjs --prepare
```

**This is not an API endpoint and does not run automatically on startup, from an agent, or when a grant is issued.** It must be explicitly invoked by the local operator. It refuses arbitrary command arguments, remote Docker engines, modified image entrypoints, existing output bundles, and changing the pinned source version.

It creates an isolated staging directory under `.local/pinned-api-runner/`, which is Git-ignored. Only once all fixed checks and the real offline TypeScript validation succeed, it publishes:

```text
.local/pinned-api-runner/pinned-7104f723c4ee/
  source/                      immutable tracked-only Git archive
  manifest/tracked-files.bin   independently pinned full Git blob list
  store/                       filtered, script-free API pnpm 12.18.0 cache
  engine/schema-engine         pinned Prisma 7 Alpine-musl ELF
  provisioning.json            non-secret provenance/validation receipt
  task-typecheck.env.example   fixed image ID + four local paths (no secrets)
```

If provisioning fails, the temporary staging bundle is removed; existing bundles are never overwritten. The source repository checkout and other project worktrees are untouched. A new runner image may be built locally, but no application execution is enabled without separate operator approval.

## Provisioning trust boundaries

There are **two separate containers**, not a network-enabled runtime:

1. **Trusted network stage** — build the fixed Dockerfile at `packages/local-provisioner/Dockerfile` from an exact Alpine 3.23 digest. It has an unprivileged UID, read-only root, no capabilities, no new privileges, no Docker socket, no secrets or home checkout, and **exactly one writable mount**: an empty new staging folder. Git fetches only Gym Platform commit `7104f723c4ee7b81e7b9b64e9c9483aea344ef7a`, checks tree `2c140e1e740b3dd8cc7582db726f46b54b73b334` and full manifest SHA-256 `dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b`. pnpm installs only the pinned `@gym/api` dependency graph in a private disposable copy using `--frozen-lockfile --ignore-scripts --trust-lockfile`, including two required lock/SRI-pinned musl artifacts. The isolated store must be below the reviewed file/byte ceilings and have no remaining checkout symlinks. **On Windows, pnpm builds that store entirely in private Linux tmpfs** and sends it through the Docker Desktop bind as one compressed transport archive; the host validates the archive paths and file types before extraction, then scans all extracted files/limits and deletes the archive before publication. This avoids thousands of live pnpm file operations on the Windows bind. Prisma schema-engine download must satisfy the official compressed checksum, independently pinned compressed SHA-256 and independently pinned uncompressed SHA-256. The network stage never runs application scripts, TypeScript, Prisma generator, or untrusted caller commands.
2. **Offline validation** — build the reviewed `packages/runner/Dockerfile`, record and verify its exact local image ID/UID/entrypoint, then create a disposable container with **network=none**, read-only root, no capabilities, UID 65534, 5 GiB/2 CPUs/128 PIDs, and read-only source/manifest/store/engine. The `/workspace`, `/results` and `/tmp` scratch tmpfs volumes remain `noexec`. `api-typecheck-local.mjs` invokes the already CI-proven fixed compiler recipe, re-verifies the complete immutable source, pinned pnpm dependency graph and Prisma engine, and returns a typed success receipt. The host checks the container configuration before it starts, verifies the result and forces daemon-side cleanup.

A successful bundle records a `task-typecheck.env.example` file. **Review and copy only its non-secret path/image entries into your own local configuration**. It does _not_ write to a live `.env` and deliberately does **not** enable:

```text
DEV_HUB_ENABLE_TASK_GRANTS=true
DEV_HUB_ENABLE_TASK_EXECUTION=true
DEV_HUB_TASK_GRANT_OPERATOR_SECRET=<separate random 32–256 byte secret>
```

Enable these only when personally ready to approve one use of the fixed recipe. The one-time grant still expires in 45 seconds, is bound to the exact verified worktree and cannot be replayed. See `docs/operator-api-typecheck.md`.

## Failure handling and limitations

- Provisioning needs **trusted network access only while downloading immutable inputs and building the two images**. The actual API_TYPECHECK always runs offline. Do not pass API keys, npm tokens or GitHub credentials to the provisioner container.
- The script is safe to run only against a **reviewed, trusted local copy of this Hub code**. A compromised Docker daemon, malicious host toolchain or modified trusted image builder is outside this guarantee.
- The initial script intentionally refuses to overwrite an existing bundle. Future work can add explicit versioned refresh, verification-only mode, migration to a newer reviewed Gym Platform commit, crash recovery and secure automatic path configuration.
- Successful provisioning **does not prove** the later HTTP one-time operator-authenticated flow; that still requires an actual local operator grant, session and hydrated matching worktree.
- If the Docker daemon or host crashes during provisioning, inspect and remove orphan containers prefixed `gym-devhub-pinned-stage-` or `gym-devhub-provision-check-`. The script attempts explicit cleanup for normal failures and timeouts.
