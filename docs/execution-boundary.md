# Docker Execution Boundary — Preflight (PR #7)

Gym Dev Hub introduces a **deny-by-default container isolation preflight** as the first slice of a future agent execution boundary. This PR **does not add an agent command runner, grant permissions, mount project repositories, or enable code changes**.

## Local prerequisites

- Docker Desktop running with **Linux containers**.
- A local Docker context using a Windows named pipe (`npipe://`) or Linux Unix socket (`unix://`). Remote TCP/SSH Docker Engines are refused.
- One pre-pulled, pinned Alpine image:

```powershell
docker pull alpine:3.23
docker image inspect alpine:3.23
```

The image used by the service is fixed to `alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2`. The service uses `--pull=never`: it will not download images automatically or substitute a different image. If the requested digest is missing, the result is unavailable. Pin updates require a separate code review.

## What the preflight checks

Open `http://127.0.0.1:3100/workspace` and choose **Перевірити ізоляцію**.

The local NestJS API starts a **single fixed diagnostic process**, _not_ user/AI code, in an ephemeral Alpine Linux container with:

- `--network=none` and no published ports
- `--read-only` root filesystem; only `/tmp` is a small ephemeral `tmpfs`
- `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--user=65534:65534`
- `--pids-limit=32`, `--memory=128m`, `--cpus=0.5`
- `--ipc=none`, `--rm`, no Docker socket or host mounts, and no application secrets in the child process environment

The diagnostic program verifies that the user is non-root, creating files in the root filesystem fails, and an ephemeral file can be created and removed under `/tmp`. The UI displays an explicit outcome: **not checked**, **running**, **passed**, **failed**, or **unavailable**. The probe runs only on request; concurrent requests are deduplicated.

## HTTP contract

- `GET /workspace/boundary/status`: query last in-memory preflight state without launching Docker
- `POST /workspace/boundary/preflight`: invoke the fixed preflight (no request payload or command argument is accepted)

Next.js exposes the same paths under `/api/workspace/boundary/*` using the existing same-origin and JSON-only write rules. The preflight is bounded by process timeouts and response size limits; failures are reported without exposing raw paths or Docker stderr.

## Security and next steps

**A passed preflight is not a general security guarantee.** It tests an isolated _diagnostic container_, not the current Codex app-server process. The Codex chat from PR #6 continues to run on the host with its earlier read-only settings; **it is not moved into Docker in this PR**. Containers also share the Linux kernel and are not a complete defense against kernel/runtime vulnerabilities.

The API must remain **localhost-only**, because Gym Dev Hub does not yet have a user login. Do not expose its endpoints to other devices or public networks.

Future independently reviewed PRs should:

1. Create a dedicated worker image and a fixed worker protocol (no direct arbitrary host shell).
2. Mount **only approved, per-task Git worktrees** into an isolated worker, with explicit path and permission validation.
3. Add signed, single-use user approvals, bounded execution, process cancellation, auditing, and cleanup.
4. Run a complete canary test against worker execution before enabling any mutations or GitHub write operations.

The programmatic field `agentExecutionEnabled` is intentionally **always false** in this PR.
