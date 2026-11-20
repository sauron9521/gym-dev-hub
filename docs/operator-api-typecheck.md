# One-use operator-controlled pinned API_TYPECHECK (#37b)

This is an **opt-in localhost execution endpoint**, not a generic task runner. It runs one fixed TypeScript compiler recipe for one reviewed immutable Gym Platform commit. By default **no execution is possible**. No new agent tool, automatic merge or arbitrary shell command is enabled.

## Operator configuration and prerequisites

The API already binds to 127.0.0.1. The existing separate task-grant feature must be enabled and the operator secret must be strong and private. A second, independent execution toggle is required:

```text
DEV_HUB_ENABLE_TASK_GRANTS=true
DEV_HUB_ENABLE_TASK_EXECUTION=true
DEV_HUB_TASK_GRANT_OPERATOR_SECRET=<independent 32–256 byte random secret>

DEV_HUB_TASK_RUNNER_IMAGE_ID=sha256:<64 hex digits from docker image inspect>
DEV_HUB_TASK_SOURCE_SNAPSHOT=<absolute trusted folder: pinned tracked-only Git snapshot>
DEV_HUB_TASK_SOURCE_MANIFEST=<absolute trusted folder: tracked-files.bin>
DEV_HUB_TASK_PNPM_STORE=<absolute trusted folder: pinned script-free pnpm store>
DEV_HUB_TASK_PRISMA_ENGINE=<absolute trusted folder: pinned schema-engine>
```

Build the reviewed image manually with the repository's existing `packages/runner/Dockerfile` and record its exact **image ID** using `docker image inspect gym-dev-hub-node-runner:v1 --format '{{.Id}}'`. The API never pulls or builds an image. The image must match that ID and reviewed metadata (Linux x64, non-root, original fixed runner entrypoint).

The four input folders must be provisioned separately by the trusted operator, from exactly the Git commit, manifest, lockfile and binary engine **already verified in the CI workflow** `.github/workflows/private-prisma-native-preflight.yml`. They are not built or downloaded by the API. Directory paths must be absolute, canonical and free of symlinks/junctions; Docker mounts them read-only. The container rechecks every source Git blob against the pinned manifest, verifies the store and engine digest, and installs dependencies only in disposable private tmpfs with `--offline --frozen-lockfile --ignore-scripts`. Missing or mismatched inputs fail closed. **The project has no self-service local artifact provisioner yet**; until these artifacts are prepared the endpoint remains unavailable even if the flag is true.

The eligible worktree must be fully hydrated and have a freshly verified fingerprint for commit `7104f723c4ee7b81e7b9b64e9c9483aea344ef7a`. A worktree based on a different commit cannot receive the grant. The operator must first run `POST /workspace/boundary/preflight` so the Linux Docker Engine check passes within five minutes.

## Two explicit HTTP steps

First authorize via the existing endpoint:

```text
POST /workspace/sessions/:sessionId/worktree-plans/:planId/task-grant-authorize
```

The body is the existing strict schema: `recipeId=API_TYPECHECK`, reviewed commit/tree/manifest, exact current worktree fingerprint, literal `I_APPROVE_API_TYPECHECK_ON_PINNED_SOURCE_ONLY` and the independently configured operator secret. It returns a **one-time, 45-second** bearer `grantToken`. Never store the token or secret in URLs, Git logs, persisted browser storage, screenshots or analytics.

Then, before it expires, call:

```http
POST /workspace/sessions/:sessionId/worktree-plans/:planId/task-execute
Content-Type: application/json

{
  "runId": "<client-generated UUID v4>",
  "grantToken": "<one-time token>",
  "recipeId": "API_TYPECHECK",
  "fingerprint": "sha256:<current 64 hex>",
  "sourceCommit": "7104f723c4ee7b81e7b9b64e9c9483aea344ef7a",
  "sourceTree": "2c140e1e740b3dd8cc7582db726f46b54b73b334",
  "sourceManifestSha256": "dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b"
}
```

The local service checks its separate feature flag, the recent Docker preflight and the **exact locally pinned image/four trusted folders** before consuming the token. Grant consumption is atomic and re-runs the live verified worktree preview. The grant is burnt before any Docker task; retrying requires fresh operator approval. No input can choose a different recipe, command, image, mount path or environment.

The API is **single-flight**: only one typecheck can run in this process at a time. A successful response contains run/grant IDs, pinned commit, exit code 0, bounded output byte counts, elapsed time and confirmed container removal. It does not contain credentials or raw project logs.

To request cancellation from another local HTTP request:

```http
POST /workspace/sessions/:sessionId/worktree-plans/:planId/task-cancel
Content-Type: application/json

{
  "runId": "<same client-generated UUID>",
  "operatorSecret": "<operator secret>"
}
```

A successful cancel response says `cancel-requested`, **not** that Docker is already cleaned up. The execution request subsequently fails, and the Docker adapter attempts daemon-side `docker rm --force` with cleanup verification. If the host or Docker daemon crashes, the operator must inspect orphaned `gym-dev-hub-api-typecheck-*` containers; automatic crash recovery will require a later PR.

## Container boundary and trust model

- Local Linux Docker only; no remote Engine, network or Docker socket bind.
- Reviewed image ID, explicit `--pull=never`, UID/GID 65534, read-only root, no capabilities, `no-new-privileges`, no IPC.
- Fixed 2 CPU, 5 GiB RAM, 128 PIDs, 600 s overall deadline; three noexec private tmpfs volumes.
- Four verified read-only bind sources: `/source`, `/manifest`, `/store`, `/engine`. The active worktree path is never mounted into the container.
- Runtime accepts **no** package scripts, shell, caller-supplied argv, environment variables, network, Git push or merge.
- The CI-proven compiler is invoked by a new `api-typecheck-local.mjs` wrapper. The **host** verifies/burns the grant; the **container does not receive or independently validate the bearer token**. Its receipt truthfully states `delegatedAuthorization=host-service-only`, rather than impersonating a CI-only, no-grant response.
- The existing CI-only compiler proof remains independently tested in CI; local wrapper has separate positive/negative tests.
- Docker process output is capped at 64 KiB, no raw stdout/stderr is returned by the API. Failure replies are generic to avoid leaking private host paths or project contents. Audit records only the issued/authorized grant and fixed non-secret scope.

**Important limitations:** this is an initial fixed-snapshot, localhost-only developer capability. The API has no user login and should never be exposed publicly. The operator must provision the immutable bundle and build a pinned image manually; no automatic dependency refresh or per-PR source checkout is enabled. A future slice should add securely automated local provenance provisioning, verified error summaries/status streaming and crash-recovery cleanup.
