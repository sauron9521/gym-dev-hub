# Fixed worker tool capability — PR #17

PR #17 introduces a narrow control-plane permission for **one fixed `SHA256_FILE` action**, executed by the hardened ephemeral Docker worker against one explicitly approved file. This is a concrete test of agent-tool authorization, **not general-purpose agent execution**. Repository code is never evaluated. No arbitrary shell, network, file write, Git push, PR creation or merge is enabled.

## Independent opt-in

Rebuild the reviewed worker image after this PR (it adds the fixed protocol request):

```bash
docker build --pull=false --network=none --tag gym-dev-hub-worker:v1 --file packages/worker/Dockerfile packages/worker
```

Only in the ignored local `apps/api/.env`, generate and configure an independent strong secret:

```dotenv
DEV_HUB_ENABLE_WORKTREE_MOUNT=true
DEV_HUB_ENABLE_WORKER_TOOLS=true
DEV_HUB_WORKER_TOOL_SECRET=<independent-random-secret-with-at-least-32-bytes>
```

The worker-tool feature is **disabled by default**. Its secret is separate from `DEV_HUB_WORKTREE_OPERATOR_SECRET`, and enabling scoped code reads does not authorize tools. Never expose the local API or dashboard on untrusted networks because the MVP has no user accounts.

## Permission boundaries

1. A session owns a SHA-pinned, hydrated worktree from the repository allowlist. The operator runs Git blob integrity validation.
2. Run fresh local Docker Safety Preflight (successful, less than five minutes old).
3. Select one relative source file (maximum **8 KiB**), and check the **separate** tool consent box.
4. Enter the independent `DEV_HUB_WORKER_TOOL_SECRET`. The API accepts only the exact `tool: "SHA256_FILE"` capability, correct worktree fingerprint and approved file.
5. The API issues a cryptographically random **60-second, single-use token** bound to session, plan, pinned commit, source folder, file path and capability. It consumes the token synchronously before asynchronous work.
6. On execution, the API repeats preflight, worktree integrity, and file checks. It writes a durable `tool-run-started` audit event before any Docker side effects.
7. The worker uses only `CHECK/1 SHA256 <relative-file>`. It checks the same path and 8 KiB bounds inside Docker and returns **only a 64-character SHA-256 digest**. It does not transmit the file bytes to the browser.
8. The API validates the digest and worker protocol, shuts down and removes the container, records `tool-run-completed` or `tool-run-failed`, then returns the digest.

All inherited Docker guards are unchanged: one read-only mount, no network, non-root user UID 65534, read-only root filesystem, no capabilities, no-new-privileges, CPU/memory/PID limits and daemon-side cleanup. Both requested and actual Docker mount metadata are checked.

## API

```http
POST /workspace/sessions/:sessionId/worktree-plans/:planId/tool-authorize
Content-Type: application/json

{"fingerprint":"sha256:...","tool":"SHA256_FILE","filePath":"apps/api/src/main.ts","operatorSecret":"..."}

POST /workspace/sessions/:sessionId/worktree-plans/:planId/tool-execute
Content-Type: application/json

{"grantToken":"..."}
```

The Next.js Workspace same-origin proxy expressly allowlists both routes. There is **no command, argument array, container flag, arbitrary tool ID or source-path override** in the execution request.

## Known limitations and follow-ups

- The hydrated source files are mode `0600`; UID 65534 usually cannot read them. Failure is expected until a separately reviewed _safe ephemeral copy/permission strategy_ is implemented. PR #17 never changes host file permissions or bypasses the worker security policy.
- Windows Docker Desktop path translations and 8.3 paths still require a local Home-PC verification; hosted CI cannot establish the machine's path policy.
- A successful SHA-256 tool action is **not** a permission for Codex to execute code, install packages, run tests, write files or invoke a shell.
- The local user account and administrator can modify files concurrently; the repeated integrity check is a best-effort boundary, not an OS-level immutable snapshot.

## Validation

Linux CI: formatting, linting, typecheck, API/Web unit tests and builds. Windows: worktree policy and tool authorization tests. Real Linux Docker workflow: a harmless fixture checksum, rejected traversal and rejected arbitrary `RUN/1`, plus removal check. Always review CI on the **final PR head SHA** before merge.

**Next PR:** a safe source-file staging or UID access policy for real Docker Desktop use, then explicit allowlisted task runners and their independent permission/review gates. Keep execution of untrusted repository scripts disabled until that design is reviewed.
