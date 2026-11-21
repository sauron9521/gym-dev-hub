# Issue #107 — isolated real Docker recipe smoke (operator only)

This **optional, manual-only** Linux probe verifies the actual pinned, network-disabled
Docker runner for three existing `WEB_*` recipes without reusing any user
grant. It is not a substitute for the real **HTTP grant → Docker execution →
production audit receipt** workflow acceptance required before closing #107.

## Before running

1. Do not stop the running Hub. Use a clean, **separate disposable Git worktree** with
   the same trusted repository origin and build it with
   `pnpm install --frozen-lockfile --offline`, then
   `pnpm --filter @gym-dev-hub/contracts build` and
   `pnpm --filter @gym-dev-hub/api build`.
2. The existing _private_ owner-managed `apps/api/.env` holds the verified pinned
   `DEV_HUB_PATCH_CHECK_IMAGE_ID` and `DEV_HUB_PATCH_CHECK_PNPM_STORE`. Never copy
   that file into the disposable worktree, commit its values or paste them into logs.
3. The store must match the **exact current source lockfile**. If a previously
   configured store is stale, prepare and verify a new one in the isolated
   checkout with `pnpm provision:patch-check-store` and
   `pnpm provision:patch-check-store:verify`. Supply its _new_ absolute path as
   `DEV_HUB_PATCH_CHECK_PNPM_STORE` in the operator environment for this
   invocation only; do **not** overwrite the live API `.env` or an old store.
4. From the disposable worktree, explicitly run:

   ```sh
   sg docker -c 'node --env-file=/home/sauron/Projects/gym-dev-hub/apps/api/.env scripts/launch-fixed-docker-smoke.mjs --confirm-isolated-docker-smoke'
   ```

The probe refuses root, remote/TLS Docker contexts, nonlocal Unix socket paths,
world-accessible/non-socket Docker endpoints, missing pin, or missing explicit
confirmation. It reads only the **committed tracked Git tree** using `git archive`,
never developer dirty files, ignored secrets, `node_modules`, primary worktrees
or production audit. Its temporary directory is owner-created under `/tmp`,
archive and synthetic JSONL audit remain private. The script creates a
**disposable Docker-readable copy of only the verified public dependency
store** and source stage, without weakening permissions on the original
0700/0600 store. Both copies are available to the fixed non-root Docker
UID 65534 and removed after the probe; no secret/private source is copied. All Docker checks go through
the existing `preparePatchCheckRunner` and `runPatchChecksDocker` validation
and cleanup. No `Dockerfile` or arbitrary command input is accepted.

Expected result is a **metadata-only** JSON report with:
`recipesPassed: ["WEB_FORMAT","WEB_TYPECHECK","WEB_TEST"]`,
`temporaryAuditOnly: true`, `productionAuditWritten: false`, and a
test-only unfinished attempt projected as `interrupted`, **never** `passed`.

If an isolated Docker recipe fails, exit is nonzero and **no green proof
may be claimed**. This test does not authorize or publish any GitHub write,
change the running Hub or run a production workflow grant. A passed test-only
journal demonstrates durable audit serialization/projection, not that a
real operator-authorized grant has executed. Follow up with actual operator
HTTP receipts, stable API PID checks and a controlled interrupted test
for full #107 acceptance. Keep #107/#79 OPEN until those checks pass.
