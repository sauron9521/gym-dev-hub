# Scoped one-file Docker code read (PR #16)

This is **not an autonomous agent**. An operator explicitly authorizes one bounded source file for one ephemeral, isolated worker. The fixed worker shell only recognizes `HELLO/1`, `PING/1`, `READ/1 <relative-file>`, and `SHUTDOWN/1`. Arbitrary commands, Codex in Docker, file writes and network access remain disabled.

## Local setup

Rebuild the reviewed local worker after updating the code, because PR #16 changes the fixed protocol:

```bash
docker build --pull=false --network=none --tag gym-dev-hub-worker:v1 --file packages/worker/Dockerfile packages/worker
```

Do **not** enable features on an untrusted network. The development API has no user accounts. Set in the ignored `apps/api/.env` only:

```dotenv
DEV_HUB_ENABLE_WORKTREE_MOUNT=true
DEV_HUB_ENABLE_SCOPED_CODE_READ=true
DEV_HUB_WORKTREE_OPERATOR_SECRET=<local-32+-byte-secret>
```

Both flags are disabled by default. Do not commit or paste the operator secret.

## Approval and execution

1. Create and hydrate an explicitly approved SHA-pinned worktree and run its complete Git blob integrity check.
2. Run Docker Safety Preflight on the local Linux Docker Engine. Its pass must be less than five minutes old.
3. In Workspace, enter one relative file path (for example `apps/api/src/main.ts`), check the separate file-reading consent box and enter your local operator secret.
4. The API checks the exact plan/session, pinned Git commit, fingerprint, repository allowlist, integrity, and selected file. Only ordinary UTF-8 files up to **8 KiB**, using a small allowlist of code/documentation extensions, are accepted. Dot paths, traversal, symlinks and non-files are refused.
5. A random **single-use, 60-second token** is issued solely for that one file. The token is consumed before asynchronous work. On use the API repeats the Docker Safety Preflight, full Git blob verification and file checks.
6. A short-lived container runs as `65534:65534`, with no network, no capabilities, read-only rootfs, strict limits and one read-only bind. Both requested and observed Docker mount metadata must match the exact planned source. No Docker socket is mounted. The worker reads the single file and emits base64-encoded content in a bounded JSON response, then shuts down. The API verifies strict UTF-8 and reports the text.
7. An audit entry records `code-read-started`, `code-read-completed` or `code-read-failed`. The Docker container is removed even on errors. No persistent mount, token or agent shell is left behind.

Routes: `POST .../:planId/code-read-authorize` and `POST .../:planId/code-read` (same-origin Next proxy allowlist).

## Windows / Docker Desktop boundaries

- Docker Desktop often reports drive-letter paths as `/run/desktop/mnt/host/f/...` or `/host_mnt/f/...`. PR #16 recognizes these explicit translations only when the entire canonical relative path matches. It also verifies Docker's effective `.Mounts` metadata and refuses extra or writable mounts.
- **Unknown translations, short 8.3 aliases and paths with dot segments are refused**. Never bypass this check by changing the expected path.
- Hydration writes files with mode `0600`; the container's unprivileged UID `65534` may **not** be able to read them. The API does not chmod, chown or widen host permissions automatically. A denied read is a safe failure, not proof that the system is broken.
- GitHub Actions verifies Linux container safety and Windows parser rules, **not the real Home-PC's Docker Desktop path mapping or file permissions**. Verify these locally before relying on this feature.

## Explicit non-goals

No arbitrary shell or agent tool invocation, no Codex workspace mount, no automatic read of repository trees, no changing source files, no Git writes, no GitHub push, and no merge. Those require independent permission designs and separately reviewed PRs.
