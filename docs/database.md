# Shared Agent Memory database foundation (Issue #36)

This is an **opt-in, local-only PostgreSQL 17 / Prisma 7** database for **Gym Dev Hub**, distinct from `gym-platform`. The feature remains **disabled by default**: existing `agent-workspace.json`, Codex chats, Docker operator grants, worktree APIs and GitHub integration do not require PostgreSQL. The only new HTTP path is `GET /v1/memory/status`, which intentionally returns **503 disabled** even if storage is configured; memory reads/writes remain unavailable pending authenticated scope and operator approval (#39–#40). No fallback to JSON memory data is possible. See [ADR-001](architecture/shared-agent-memory.md).

## Local installation (explicit opt-in)

Require Docker, Node 24, pinned pnpm, and an isolated workstation. Never run as root or expose a PostgreSQL socket on the LAN. Configure the **ignored** `apps/api/.env` locally (do not paste keys in PRs, screenshots or logs), with your own unique random password (e.g. `openssl rand -hex 24`). Use only ASCII alphanumeric/hex secrets to avoid URL encoding issues.

```dotenv
DEV_HUB_MEMORY_ENABLE=true
DEV_HUB_MEMORY_DB_PASSWORD=<private-random-secret>
DEV_HUB_MEMORY_DB_PORT=55441
DEV_HUB_MEMORY_DATABASE_URL=postgresql://gym_dev_hub:<same-private-random-secret>@127.0.0.1:55441/gym_dev_hub_memory
```

The Compose service cannot start unless its password is supplied. It publishes **only** `127.0.0.1:55441`; the volume name is namespaced to this Hub. Never use any `gym-platform` credentials or database URL. The source-controlled `.env.example` has placeholders, **no real credentials**.

```bash
pnpm install --frozen-lockfile
pnpm memory:db:up           # Docker Compose, explicitly; opt-in volume
pnpm memory:db:generate     # Prisma 7 client; stored only in ignored .local/
pnpm memory:db:migrate      # guarded: only gym_dev_hub_memory on loopback
pnpm memory:db:health       # SELECT current_database + Prisma ledger
pnpm memory:db:down         # stops container; preserves volume and user data
```

Use `pnpm memory:db:status` at any time: without the enable flag it reports `HUB_MEMORY_DISABLED` without opening a socket. `db:health` and `db:migrate` **fail nonzero** if disabled, missing, malformed or inaccessible. The connection guard allows only user `gym_dev_hub`, password, loopback host and exact database `gym_dev_hub_memory` for development. It does not accept `postgres`, `gym_platform`, remote/cloud hosts, or alternate schema query parameters. The CLI never prints the credential or detailed driver exception. If the endpoint is unavailable, storage fails closed; it does not redirect to the Workspace JSON.

Prisma 7 uses an explicit `apps/api/prisma.config.ts` datasource URL and a custom `prisma-client` generator output in `apps/api/.local/generated/prisma`. Install-time Prisma lifecycle scripts are **explicitly denied** in `pnpm-workspace.yaml`. Run `pnpm memory:db:generate` only from a trusted checkout after reviewing pinned dependencies. The initial tracked migration contains **no memory tables**; Issue #37 adds typed revisioned storage in `20261121124913_memory_typed_records`; see the [memory model and migration runbook](memory-model.md). Issue #38 implements a [repository-scoped internal read engine](memory-read-api.md) with **disabled public HTTP routes**; Issues #39–#40 add authentication and guarded writes. Do not run Prisma commands directly against arbitrary URLs. Direct `prisma migrate`, `prisma db` and `prisma studio` operations are also blocked unless the feature is explicitly enabled with a validated local Hub database URL.

## Dedicated test DB / CI

Test commands accept **only** a separate `gym_dev_hub_memory_test` database on loopback via `DEV_HUB_MEMORY_TEST_DATABASE_URL`. The DB and its Prisma migration ledger must be created within an **ephemeral isolated PostgreSQL container**, and tests must never migrate, truncate or drop the development DB. Normal `pnpm check` runs policy/unit tests without any DB; the integration test is skipped unless both `DEV_HUB_MEMORY_ENABLE=true` and the exact test URL are provided. The separate [CI workflow](../.github/workflows/memory-postgres.yml) creates an ephemeral PostgreSQL 17 service whose fixed password is a _CI-only disposable fixture_, runs `db:generate`, `db:migrate:test`, `db:health:test`, integration/negative tests and full `pnpm check`; the hosted runner destroys the test database automatically. No production DB secrets or persistent volume are present in CI.

For a local integration test, use a **separate test-only** container/DB (not the development database), set a unique ephemeral credential and `DEV_HUB_MEMORY_TEST_DATABASE_URL`, then run:

```bash
pnpm --filter @gym-dev-hub/api db:migrate:test
pnpm --filter @gym-dev-hub/api db:health:test
pnpm --filter @gym-dev-hub/api exec vitest run test/memory-database-integration.spec.ts
```

Any attempt to use the development URL for `:test`, or vice versa, is rejected before opening a connection. Database creation/deletion is performed by the isolated PostgreSQL CI service; **no generic create/drop-database command** is exposed by Hub.

## Data preservation and rollback

Do **not** copy, rename or delete the existing `apps/api/.local/agent-workspace.json`. This PR includes no migration of sessions/notes and does not add memory models. Before a future data migration (#48), take a checksum-verified byte-for-byte backup, run a dry-run import with provenance/redaction, and require explicit operator approval. To roll back this foundation, set `DEV_HUB_MEMORY_ENABLE=false` and stop Compose with `pnpm memory:db:down` (no `--volumes`); existing Workspace and chat continue unchanged. **Do not run `docker compose down --volumes`** against a database containing data.
