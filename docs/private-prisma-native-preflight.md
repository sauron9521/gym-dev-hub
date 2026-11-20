# PR #33 — Real Prisma 7 Client generation in private Docker storage

This is the **first fixed, intentional Prisma code generation** on a real, immutable Gym Platform snapshot. It uses the entire offline API dependency closure proved in PR #32, but writes **only to a disposable private filesystem**, never to the original read-only Git source or a developer's worktree.

## Exact source and command

The trusted GitHub Actions runner checks out public `sauron9521/gym-platform` at commit `7104f723c4ee7b81e7b9b64e9c9483aea344ef7a`, tree `2c140e1e740b3dd8cc7582db726f46b54b73b334`, with independently pinned complete source manifest SHA-256 `dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b`. The snapshot contains **1,258 Git-tracked files** and excludes `.git` and ignored/untracked files. The actual 1,631 pnpm resolution hashes and the complete `@gym/api` dependency graph are independently audited first.

Trusted CI fetches the full real API dependency closure into a short-lived store with pnpm 12.18.0, `--frozen-lockfile --ignore-scripts --trust-lockfile`, as in PR #32. Verified pnpm host backlinks are removed. The cache is **mounted read-only** alongside the full read-only source and Git manifest into networkless Docker.

The new fixed CI-only `prisma-native-preflight.mjs` calls the reviewed `offline-api-cache.mjs`, which validates the exact full source, copies source + cache into private tmpfs, installs the real API package graph **offline and without lifecycle scripts**, and rechecks the locked versions. Only after all these checks pass does it invoke the **single fixed** Prisma CLI:

```text
/bin/sh /usr/bin/devhub-pnpm --dir /workspace/project/apps/api exec prisma generate --config prisma7.config.ts --no-hints
```

This command intentionally runs reviewed, pinned Prisma 7 CLI JavaScript and reads the exact pinned, reviewed `apps/api/prisma7.config.ts` and Prisma schema source. Neither command name, arguments, working directory nor source snapshot is provided by an HTTP caller, Codex agent, or user-editable task field. The output is pinned to `/workspace/project/apps/api/src/infra/database/generated/prisma`. The script validates expected Prisma 7 `client.ts`, `browser.ts`, `enums.ts`, bounded generated file counts and byte sizes, disallows output symlinks, and re-checks that the immutable source mount never got a generated client. It also confirms the pnpm lockfile digest did not change.

## Isolation boundary

The Docker container is nonroot (UID 65534), has `--network=none`, a read-only root filesystem, no added capabilities, no-new-privileges, disabled IPC, a 128-PID limit, and no Docker socket, GitHub credentials, environment secrets, database or application services. The CI sets 2 CPUs and 5 GiB RAM.

Three mounts — `/source`, `/manifest`, `/store` — are read-only. Three temporary memory-backed `noexec,nodev,nosuid` tmpfs volumes keep the project/dependency graph, results, and temporary files private. **`noexec` alone does not stop interpreted JavaScript**. Here the exact Prisma CLI executes intentionally and is isolated with the other controls. The private workspace is destroyed when Docker exits; no generated artifacts are uploaded or written back.

CI verifies the actual Docker configuration/mount identities and rejects a tampered Prisma schema or missing cache in separate negative Docker runs. The ordinary diagnostic runner protocol, NestJS API, task grants and Codex integration **cannot invoke this preflight**. GitHub PR merges remain manual.

## Remaining limitations

The generated client proves only that a reviewed `prisma generate` operation can run on the fixed source with the pinned offline packages. It **does not** validate the runtime/native loads of `bcrypt`, `sharp`, Prisma engines, or platform-specific prebuilt binaries; nor does it run the API compiler, connect to PostgreSQL, run application scripts or tests, or grant execution to users. The existing `allowBuilds` entries are an audited source policy, not blanket approval to run arbitrary dependency lifecycle scripts. Any required native binary provisioning must be reviewed independently.

The follow-up PR should validate native artifacts under the intended Node/Alpine platform and only then add a separately reviewed fixed `API_TYPECHECK` proof. A later product API integration requires a **fresh, single-use operator grant**, independently verified working tree and immutable source identity, bounded logs/timeouts, and explicit cleanup; this PR does not change those permissions.
