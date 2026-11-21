# Shared Agent Memory — schema v1 (Issue #37)

**Current rollout:** DB schema and typed contract only; **no memory reads, writes, sync, leases, approvals or MCP operations** are exposed. `/v1/memory/status` still returns **503** even if the operator configures PostgreSQL. Existing `agent-workspace.json` and `gym-platform` remain untouched. See [ADR-001](architecture/shared-agent-memory.md) and [database runbook](database.md).

## Repository ownership

The schema adds seven tables to the **Hub-only** PostgreSQL database:

| Table / Prisma model                              | Purpose                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `memory_repositories` / `MemoryRepository`        | Allowlisted repo slug (`owner/repository`), provisioned by a trusted operator, never by AI messages |
| `memory_tasks` / `MemoryTask`                     | Scoped external task IDs unique per repository                                                      |
| `memory_agent_identities` / `MemoryAgentIdentity` | Agent identity with a repository-specific external reference                                        |
| `memory_sessions` / `MemorySession`               | Session-bound task/agent in the **same** repository                                                 |
| `memory_records` / `MemoryRecord`                 | Current bounded text, kind, scope, status, revision, source SHA, verifier and supersession          |
| `memory_sources` / `MemorySource`                 | Attributed external provenance with actor/source ref/SHA/observation time                           |
| `memory_revisions` / `MemoryRevision`             | Transactional, **append-only** snapshots for every insert and numbered record update                |

`MemoryKind`: fact, decision, constraint, proposal. `MemoryStatus`: proposed, verified, superseded, revoked. `MemoryScope`: project, task, session. For project scope, `taskId` and `sessionId` must be null; task/session scopes require exactly the corresponding ID. `agentId` may further restrict visibility, but **does not grant access**. The shared `@gym-dev-hub/contracts` package exports strict Zod v1 DTOs and inferred TypeScript types; `schemaVersion` is exactly `1`, timestamps are ISO-8601, optional relationships are explicitly nullable, and text has a 4,096-character limit.

All parent and child tenant relations use `(repository, id)` compound foreign keys with **ON UPDATE RESTRICT / ON DELETE RESTRICT**. Invalid repo names, missing repo allowlist entries, cross-repository task/session/agent or source links and invalid scopes fail at the **database** layer. Every list query in later #38 must still include an authenticated `repository` filter; SQL foreign keys **do not** replace authorization or enable RLS. Every repository must be granted explicitly in a later operator-controlled setup; never use a wildcard repository or default `gym-platform` scope.

## Revision and provenance invariants

Prisma's `revision Int` is the current record version. Every `INSERT memory_records` creates a revision-1 snapshot **in the same DB transaction**. Every later `UPDATE memory_records` must increase `revision` by **exactly 1** or the DB rejects it. The future #40 approval endpoint will perform a compare-and-swap with `WHERE id = ? AND repository = ? AND revision = expected`; on contention one writer obtains the row, the other gets 0 updates and must return HTTP 412, not silently overwrite.

DB triggers reject all `UPDATE` and `DELETE` of `memory_revisions` and `memory_sources`, all physical `DELETE` of memory records and moves between repositories. `REVOKED` status is terminal. The status transition to `VERIFIED` requires nonempty `verifiedBy`/`verifiedAt` at DB level; **this is not yet proof of authenticated operator approval**, because app roles and authorization are a separate issue #39/#40. `SUPERSEDED` preserves the former revision plus a same-repo link to the replacement record. No history cleanup/retention/backup migration is performed in #37; see #48.

The snapshot's `changedBy` defaults to `unattributed-db-write`; future write handlers may attach a trusted actor using a transaction-scoped database session setting, after strict authentication and audit in #40. Source attachments are separate append-only records: for the very first DB-triggered revision, `sourceId` is null because an external `MemorySource` cannot exist before its parent record. Later write flows must explicitly establish provenance, use an owner-reviewed proposal, and not treat bare DB authorship as verification.

## Migration and isolated tests

Issue #36's baseline migration remains unchanged. `20261121124913_memory_typed_records` is a **forward-only, additive migration** that creates tables/constraints/indexes/functions/triggers, without touching existing JSON. From a trusted checkout and dedicated local Hub PostgreSQL with explicit config:

```bash
pnpm memory:db:generate
pnpm memory:db:migrate
pnpm memory:db:health
```

Normal `pnpm check` tests the Zod contracts and API with no DB configured. The separate `memory-postgres` GitHub Actions workflow creates a **disposable** `gym_dev_hub_memory_test`, applies both migrations, and runs real SQL negative/isolation/CAS/immutability tests during `pnpm check` with explicit opt-in variables. Repository fixtures are generated with fresh UUIDs for two test-only repository scopes, never from live chat or GitHub. No developer/production database is created or dropped by test code.

**Rollback:** disable memory feature (`DEV_HUB_MEMORY_ENABLE=false`) while preserving data and original JSON. Do **not** run `prisma migrate reset`, `db push`, `docker compose down --volumes`, drop shared tables or edit an applied migration. PostgreSQL DDL is versioned forward-only; plan any necessary corrective migration separately after a verified backup. Database upgrade/checkpoint errors fail closed. Agent task leases and durable SSE/outbox events are **not** introduced here; they belong to #41 and #42.
