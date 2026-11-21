# Fixed Docker check history — PR #66

The fixed Docker check from PR #65 now has a **read-only, persistent local
history** under the corresponding Gym Dev Hub worktree plan. This is a
metadata-only review surface; it is **not** an agent permission, command
executor, CI service, source viewer, or a build artifact storage system.

## Operator workflow

1. After the explicit opt-in and local provisioning for PR #65, open
   **Workspace → Worktree plan → TypeScript / Vitest check history**. The
   panel is visible for the latest created or previously revoked/expired
   Gym Dev Hub plan, even after reloading the browser.
2. Enter the independent `DEV_HUB_PATCH_CHECK_OPERATOR_SECRET` (at least
   32 characters) and select **Показати журнал**. The browser clears the
   input after submission. To refresh, enter the secret again; **no automatic
   polling, stored token, or read access without a secret**.
3. The UI shows up to 30 latest grants/checks with a fixed recipe, status,
   request/start/finish timestamps, elapsed time when recorded, bounded
   stdout/stderr **byte counts** (never output text), run ID, shortened
   commit and patch hashes. It distinguishes authorizations that never
   ran from real completed runs.

The API uses **POST** so the secret is not placed into a URL or query string:

```text
POST /workspace/sessions/:sessionId/worktree-plans/:planId/patch-check-history
Content-Type: application/json

{ "operatorSecret": "<local independent check secret>" }
```

The result is a typed `WorktreePatchCheckHistory` with
`readOnly:true`, `rawLogsAvailable:false`, `commandsEnabled:false`,
`commitEnabled:false`, `pushEnabled:false`, `mergeEnabled:false`.
The server checks that the plan belongs to the requested session and
repository `sauron9521/gym-dev-hub`, and uses strict request validation.
There is no `GET` or unrestricted archive endpoint.

## Status semantics

| Status             | Meaning                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `authorized`       | An unexpired one-use authorization still exists in process memory                                                             |
| `expired`          | Authorization not active or expired; this is not a test result                                                                |
| `running`          | Persisted attempt matches the current in-memory run                                                                           |
| `cancel-requested` | The operator requested abort, but the final result is not known yet                                                           |
| `passed`           | An audited successful Docker result was recorded                                                                              |
| `failed`           | The check was rejected or failed; the raw error is not exposed                                                                |
| `canceled`         | The attempt was rejected after an operator abort                                                                              |
| `interrupted`      | An attempt exists without a terminal record and is not active in this process — outcome **unknown**, never assumed successful |

Legacy PR #65 records lacking durations and byte counts remain readable;
the UI uses a dash for missing metadata rather than inventing metrics.

## Storage, privacy and limits

Audit events remain in the same local `.local/patch-checks/audit.jsonl`
or separately configured absolute
`DEV_HUB_PATCH_CHECK_STATE_DIR/audit.jsonl`, so existing history is
preserved. The 1 MiB journal is append-only and bounded. Directory
permissions are `0700`, log permissions `0600` on POSIX. A
symlink, hard link, unexpected permissions, oversized or malformed record,
invalid event order, or truncated write causes a **fail-closed error**.
Records are validated before filtering by session/plan. The log has no
automatic rotation in this slice; if full, new grants fail rather than
silently deleting history. Back up/delete it only through an explicit
operator maintenance process.

Only fixed audit metadata is written: event and timestamp, generated
grant/run IDs, session/plan IDs, recipe, pinned hashes and bounded
durations/byte counts. No secret, grant token, raw source, diff, repository
file path, environment, stack trace or Docker/test stdout/stderr is
stored. A hash of the relative file path is recorded, not the path.
This local audit is **not cryptographically tamper-evident** and is not
a replacement for remote security logging or trusted backups.

On cancellation, the original executor still aborts the Docker run;
the history service also appends `cancel-requested` before its terminal
event. If a process crashes, an unfinished attempt is shown as
`interrupted`; the UI never represents a missing final event as
`passed`. A failed/canceled run does not become replayable.

## Verification and boundaries

Unit tests cover durable records, isolated sessions and plans, read
authorization, restarts, duplicate or malformed events, truncated/symlink
audit files, one-time grant behavior and the cancellation event sequence.
The history endpoint performs no Git/Docker operations and does not
require a fresh Docker preflight **to read historical metadata**, although
new executions continue to require all PR #65 gates.

The browser intentionally shows only the latest plan's history for
each session. Older plan data remains in the private audit and can be
queried by its scoped plan endpoint with the independent operator
secret. There is no automatic commit/push/PR/merge, history replay,
deletion interface, or log download in this PR.
