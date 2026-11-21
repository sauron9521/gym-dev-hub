# Shared Agent Memory read engine — implementation slice #38

**Status: internal implementation only.** `GET /v1/memory`, `/v1/memory/:id`, and `/v1/memory/:id/revisions` are **always HTTP 503 Disabled**, including when `DEV_HUB_MEMORY_ENABLE=true` and PostgreSQL is reachable. `/v1/memory/status` remains disabled. The `MemoryController` intentionally has no query-service dependency; `MemoryQueryService` is **not registered as a Nest provider**. Nothing exposes verified memory over HTTP until #39 adds actual authenticated, repository-scoped principals and explicit authorization tests. The existing Workspace JSON, GitHub control plane and Gym Platform are unaffected. No write/mutation route, MCP, Codex injection or implicit permission is introduced.

## Internal read contract

`packages/contracts/src/memory-read.ts` exports strict Zod v1 read query, trusted context, item/page and revisions DTOs. Route shapes are reserved for later authenticated use:

| Proposed path                                                    | Purpose after #39                                     | Current HTTP behavior |
| ---------------------------------------------------------------- | ----------------------------------------------------- | --------------------- |
| `GET /v1/memory?repository=&scope=&taskId=&kind=&limit=&cursor=` | Verified, sourced and unexpired list only             | 503                   |
| `GET /v1/memory/:id`                                             | Exact repository-scoped record, never cross-task      | 503                   |
| `GET /v1/memory/:id/revisions`                                   | Visible, verified revision snapshots, bounded history | 503                   |
| `GET /v1/memory/status`                                          | Disabled rollout state (existing #36 route)           | 503                   |

`MemoryQueryService` accepts **two separate inputs**: a _trusted_ `MemoryReadContext` (repository, optional taskId/sessionId/agentId), and an _untrusted_ filter query (repository, optional scope/taskId/kind, bounded limit/cursor). The repository and task requested by the filter must match the trusted context, otherwise the service returns a uniform not-found error. **Never derive the trusted context from query parameters or localStorage.** #39 must construct it from verified identity and repository grants. Until that wiring, none of these methods are reachable by an API request.

Default list includes only `VERIFIED` rows with `verifiedBy`, `verifiedAt` and a **same-repository provenance record**, unexpired as of the SQL read and no stale GitHub provenance beyond 60 seconds. Provenance includes actor/source reference, SHA and observation timestamp; it is **untrusted data** and must never be executed or treated as instructions. GitHub remains authoritative for current PR/CI facts; before any Git write, independently refresh the relevant SHA and CI state. Proposed/revoked/superseded/expired/unsourced records never enter default read responses. There is **no read cache**.

Project-scope rows are visible to authorized repository principals only when they are not agent-private; task-scope rows additionally require the exact authorized taskId; session-scope rows require exact sessionId. Agent-specific records also require an exact matching trusted agentId. Database tenant FKs from #37 remain in force but are not a substitute for query-level authorization.

## Keyset pagination and failure behavior

List defaults to 20 results and enforces 1–50 per page. Rows sort deterministically by `(updatedAt DESC, id DESC)`; cursors contain that key and a filter/context fingerprint, signed with HMAC-SHA256 using an injected, nonpersistent **32+ byte server-only signing key**. Reuse under another repository, context or filter and tampering are rejected before DB access. No cursor can grant additional repository/task/session/agent visibility. Pagination is stable for **unchanged records**; concurrent edits and expiries may change visibility, so do not claim a frozen snapshot. Cursor key rotation intentionally invalidates old cursors. A valid page provides `nextCursor` or `null`; HTTP status translation of `MemoryReadNotFoundError` (404) and Zod validation errors (400) is deferred to #39 and must never echo SQL errors or credentials.

`GET /:id/revisions` currently returns **at most 100 verified revisions** for a visible, verified, sourced record. This bounded result is not an archive/export API. Future authenticated operator history UI (#45) must handle full revision paging and must not disclose unapproved historical proposal text in default agent context.

## Testing and rollout

`pnpm check` runs unit/contract tests with no database (integration specs are explicitly skipped). The opt-in `memory-postgres` GitHub workflow uses an isolated ephemeral `gym_dev_hub_memory_test`, applies the #36/#37 migrations, runs real SQL negative integration tests for two repositories, visibility, freshness, keyset ordering, tamper and cross-context cursors, then runs full `pnpm check`. Local production API smoke must return 503 for all reserved GET routes, but health and existing Workspace must stay 200.

**Do not enable read routes or set a global memory auth bypass in this PR.** In #39 implement authenticated principals, explicit repository allowlist, same-origin/CSRF checks, bounded rate limits, safe error mapping and secret-free query/logging. #40 separately implements operator-reviewed writes and CAS/audit. If database configuration fails, return 503/disabled rather than a false empty list. Rollback: revert the unmerged code or deploy the previous release; no migration/DB schema changed, original JSON state remains intact.
