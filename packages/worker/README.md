# Gym Dev Hub isolated worker image

The fixed-protocol worker runs inside a Docker Linux container with no network or host mounts. It is **not** an agent command executor.

Build from the repo root after `docker pull alpine:3.23`:

```powershell
docker build --pull=false --network=none --tag gym-dev-hub-worker:v1 --file packages/worker/Dockerfile packages/worker
```

Its entrypoint understands _only_ newline-delimited `HELLO/1`, `PING/1`, and `SHUTDOWN/1` messages over stdin and emits fixed one-line JSON responses. Unrecognized messages are rejected. It does not run commands, evaluate input, connect to networks or receive host mounts. The backend rechecks the local Docker daemon, image labels and entrypoint, and runs by immutable local image ID rather than a mutable tag. The API's `executionEnabled` field is always false.

This is a prototype transport/worker lifecycle layer. It does not isolate the existing host-side Codex process from PR #6. An actual execution protocol, approvals, audit trail, mount handling, agent tool policies and worker cleanup recovery require separate PRs.
