# Isolated Worker Foundation (PR #8)

This milestone adds a separate, non-executing Linux Docker worker for Gym Dev Hub. It is a **fixed-protocol lifecycle demonstration**, not a Codex agent and not a general task runner. It does not access host repositories or create branches, files, PRs or GitHub changes.

## Installation

Docker Desktop must be running with Linux containers. First pass the Docker Safety Preflight in `http://127.0.0.1:3100/workspace`. It is remembered in the current NestJS process for **five minutes** only.

Build the local worker image from the repository root:

```powershell
cd F:\programer\gym-dev-hub
docker pull alpine:3.23
docker build --pull=false --network=none --tag gym-dev-hub-worker:v1 --file packages/worker/Dockerfile packages/worker
pnpm dev
```

The image has a pinned `alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2` base, the hardcoded entrypoint `/bin/sh /opt/gym-dev-hub/worker.sh`, labels `org.gym-dev-hub.worker.protocol=1` and `org.gym-dev-hub.worker.execution=disabled`, and Dockerfile user `65534:65534`. The image is **built locally with network disabled** and limited context (`packages/worker` only). No credentials are copied into the image.

## How it works

The UI offers three explicit controls on the Workspace page: **Запустити worker**, **Перевірити зв’язок**, and **Зупинити worker**.

The NestJS `WorkerService` requires a successful, recent preflight, rechecks the **local** Linux Docker context and verifies the image ID, entrypoint, user and labels. It then invokes `docker run` by immutable local image **ID**, not the mutable tag. Its hardcoded restrictions include:

- No network, published ports, host mount, Docker socket or privileged mode
- Read-only root filesystem with a tiny ephemeral `/tmp` tmpfs
- All capabilities dropped, no-new-privileges, non-root user 65534
- CPU 0.5, memory 128 MB, PID limit 32, no IPC namespace sharing
- `--pull=never` and `--rm`; Docker credentials and application secrets excluded from the CLI environment

The only messages accepted by the container's stdin are:

| Input line    | Response                                                                                  | Meaning            |
| ------------- | ----------------------------------------------------------------------------------------- | ------------------ |
| `HELLO/1`     | `{"protocol":1,"event":"ready","executionEnabled":false}`                                 | Protocol handshake |
| `PING/1`      | `{"protocol":1,"event":"pong","executionEnabled":false}`                                  | Heartbeat          |
| `SHUTDOWN/1`  | `{"protocol":1,"event":"stopped","executionEnabled":false}`                               | Graceful exit      |
| Anything else | `{"protocol":1,"event":"rejected","executionEnabled":false,"code":"UNSUPPORTED_REQUEST"}` | No execution       |

Inputs are never evaluated, converted into shell commands or passed to another process. The backend has no endpoint for arbitrary input. Its protocol validates every response and fails closed on unexpected output.

## HTTP API

- `GET /workspace/worker/status` — lifecycle state
- `POST /workspace/worker/start` — start only with a fresh passed Docker preflight and verified local image
- `POST /workspace/worker/ping` — fixed heartbeat
- `POST /workspace/worker/stop` — fixed graceful shutdown

The Next.js proxy exposes only the corresponding allowlisted routes under `/api/workspace/worker/*`. Cross-origin writes are rejected and the current API remains loopback-only.

## Security boundaries and limitations

- `executionEnabled` is **always false**; the worker cannot run Codex, arbitrary code or shell commands.
- The existing Codex app-server from PRs #5/#6 continues to run on the **host**, not inside this Docker worker. This PR does not make host-side Codex a fully isolated execution process.
- This is a **single-process** MVP. If the API process or the Docker CLI crashes mid-run, an orphan container might remain; check `docker ps -a --filter name=gym-dev-hub-worker-` and stop only identified containers. There is no cluster-wide ownership/lease mechanism yet.
- Docker Desktop itself is privileged infrastructure; container isolation is not a complete defense against kernel/runtime vulnerabilities.
- The image is locally built, not published or signed. Verification of labels/entrypoint protects against accidental tag drift, **not a malicious local Docker administrator**.
- **Do not expose Dev Hub's unauthenticated ports to a public or local network.**

GitHub Actions additionally runs the path-filtered `.github/workflows/worker-image.yml` when the worker image changes. This builds the image on Linux and tests the exact three-message protocol plus rejection of an unknown command. Unrelated PRs do not incur the Docker job.

The next separate PR should introduce a scoped per-task worktree manifest and explicit approvals before allowing any host paths, tool execution or code modification inside a dedicated worker. The owner retains manual merge control.
