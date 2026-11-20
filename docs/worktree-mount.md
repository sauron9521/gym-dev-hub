# Ephemeral Read-Only Worktree Mount (PR #15)

This slice proves a **temporary read-only bind mount** into the fixed-protocol Docker worker from PR #8. It does NOT give Codex, an agent or any user-supplied command access to that mount. The existing reusable worker remains **unmounted**.

## Explicit local opt-in

This feature is **disabled by default**. Set only in the ignored `apps/api/.env` file:

```dotenv
DEV_HUB_ENABLE_WORKTREE_MOUNT=true
DEV_HUB_WORKTREE_OPERATOR_SECRET=<at-least-32-character-random-secret>
```

The same local operator secret used for separate worktree creation/hydration steps can be reused. Keep it out of Git, chat, logs and screenshots. Restart the API after editing `.env`. Never expose Dev Hub ports on an untrusted network: this local MVP does not have user accounts or sessions.

Docker Desktop must use a **local Linux-container Engine** and the reviewed `gym-dev-hub-worker:v1` image must already be built (see `docs/isolated-worker.md`). Run **Docker Safety Preflight** in Workspace before requesting a grant. Its result must be `passed` and younger than 5 minutes.

## Workflow

1. Use PR #10 to create an opt-in metadata-only worktree; use PR #13 to hydrate raw Git blobs into it. A separate successful PR #14 integrity check verifies every Git blob hash.
2. In Workspace under the verified integrity report, review the exact worktree folder and the fixed container destination `/workspace`.
3. Check the explicit confirmation box, enter the operator secret and choose **Авторизувати тимчасовий mount**.
4. The backend compares a timing-safe SHA-256 secret digest, checks that the plan still belongs to the session and allowed repository, revalidates worktree integrity and Docker preflight freshness. It returns a crypto-random **single-use 60-second** token bound to session, plan, fingerprint, exact base Git SHA and source path.
5. Click **Перевірити Docker mount та завершити контейнер**. The token is **consumed synchronously before any asynchronous work**. The API rechecks Docker preflight and Git blob integrity, records `mount-probe-started` locally, and launches a **short-lived** worker using a verified immutable local image ID.
6. Docker runs with `--network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges --user=65534:65534 --ipc=none`, CPU/memory/PID limits and a single `--mount type=bind,source=<manifest-target>,target=/workspace,readonly` plus a small container-only tmpfs. Host credential variables and Docker socket are not passed to the container.
7. Only the fixed **HELLO/1 → PING/1 → SHUTDOWN/1** protocol is sent; the API checks the container's actual Docker mount config (exact source and destination, bind/read-only), no network, read-only root and nonprivileged user, then stops and removes the container. It records `mount-probe-verified`, or `mount-probe-failed` on failure, in the local audit history. **No persistent mount** remains after success.

## Routes

```http
POST /workspace/sessions/:sessionId/worktree-plans/:planId/mount-authorize
POST /workspace/sessions/:sessionId/worktree-plans/:planId/mount-probe
```

Both are explicitly allowlisted through the Next.js same-origin Workspace API. Authorization body is `{"fingerprint":"sha256:...","operatorSecret":"..."}`, probe body is `{"grantToken":"..."}`. There is **no arbitrary shell, Docker run flags, container entrypoint or mount source** in request bodies.

A failed probe never produces a successful response, never grants execution, and attempts daemon-side container cleanup even if the CLI process has terminated. If cleanup fails, inspect the local Docker Engine manually. A crash/restart invalidates all outstanding in-memory grants.

## Boundaries and known limitations

- The fixed worker entrypoint **does not read repository files**. The probe verifies mount policy, not a running Codex process or a functional code-reading agent. The non-root worker may lack read permission for the `0600` hydrated files; permission policy for future agent reads is a separate feature.
- Docker Desktop may normalize Windows host paths (including short 8.3 aliases and the Linux VM's internal mapping). The probe deliberately **fails closed** if the Docker-reported mount source does not match the manifest path exactly after basic normalization. This may require further Windows-specific review; never weaken checks silently.
- A green Git integrity report is not a durable authorization: the entire worktree is checked again immediately before the probe. OS filesystem operations still have races against a malicious local administrator; this is **not** a defense against hostile users changing files simultaneously.
- The container uses a verified locally built image, not a signed distribution or verified kernel sandbox. Do not mount sensitive repositories on untrusted hosts.
- The existing host-side Codex app-server is **unaffected**. There is no command execution, code writing, Git push, automatic cleanup or PR merging in this slice.

## Verification

The unit tests reject unsafe mount paths, unexpected extra binds, write-enabled mounts, stale approval, replay, invalid credentials, changed integrity, and Docker probe failure. A separate Linux GitHub Actions workflow builds the pinned fixed-protocol worker, binds a **generated test folder** read-only, confirms no write succeeds inside the container, and deletes the container. The Windows test suite validates approval and the argument policy; **the user Home-PC was offline** during implementation, so a real on-device Docker Desktop test is still required before using this in the local environment.

**Next:** explicit permissions and safe scoped agent reading inside a hardened worker, after careful Docker Desktop verification. The owner always merges PRs manually.
