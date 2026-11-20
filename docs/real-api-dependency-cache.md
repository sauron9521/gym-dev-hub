# PR #32 — Real Gym Platform API dependency cache, installed offline

This PR expands beyond the tiny offline package fixtures (#25–26) and the static full API importer audit (#31). It attempts to install **the actual `@gym/api` direct and transitive dependencies** from Gym Platform's reviewed lockfile, then rehydrate the same graph in a restricted Docker container **with no network and dependency lifecycle scripts disabled**.

This is **not** a real `API_TYPECHECK` run: it does not invoke `tsc`, `nest`, `prisma generate`, native build/install hooks, or any Gym Platform-defined scripts. The Hub API, its task grants and the diagnostic `runner.mjs` have **no execution path** to the CI-only script.

## Source and dependency provenance

The trusted CI runner checks out the exact immutable public `sauron9521/gym-platform` commit `7104f723c4ee7b81e7b9b64e9c9483aea344ef7a`, tree `2c140e1e740b3dd8cc7582db726f46b54b73b334`. The previously reviewed `api-typecheck-provisioning-gate.mjs` validates eight source Git object hashes, both real pnpm 12 lockfile documents, all 1,631 SHA-512 pins, all direct API importer versions, and Prisma/native blockers.

CI separately exports the **complete tracked-only 1,258-file source snapshot** and the independent NUL-delimited Git tree manifest with SHA-256 `dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b`. No `.git` or untracked/ignored files enter the sandbox. This remains a point-in-time proof, not a live `main` workspace test.

## Actual dependency download, then networkless install

In a **trusted networked CI step** (no target secrets, credentials not persisted), pnpm 12.18.0 is used:

```text
pnpm --filter @gym/api install --frozen-lockfile --ignore-scripts --trust-lockfile --store-dir <temporary-store>
```

This stage downloads the actual API dependency closure, including platform-relevant optional packages as selected by pnpm, but **does not run dependency install scripts or project scripts**. `--trust-lockfile` is permitted only because the reviewed commit, lockfile, workspace policy, and importer were verified in a previous step. The resulting cache is **ephemeral** (not an uploaded GitHub artifact, cross-job cache or credential-backed registry mirror). pnpm 12's host-specific project-index backlinks must be validated against exact approved paths before removal; any residual store symlink is rejected.

The trusted stage enforces a bounded cache file count and size before making it read-only. A complete source archive, manifest and cache are mounted into Docker as **three read-only binds**.

Inside networkless nonroot Docker, the fixed CI-only `offline-api-cache.mjs` rehashes the **full source tree** against the pinned manifest, checks all mounts, and refuses missing/unsafe caches. It copies the source snapshot and cache into a disposable, private, size-limited `/workspace` tmpfs and runs exactly:

```text
/bin/sh /usr/bin/devhub-pnpm --filter @gym/api install --offline --frozen-lockfile --ignore-scripts --trust-lockfile --store-dir /workspace/.pnpm-store
```

The installer works on the **private copied source**, never the original read-only Git bind. After success, the gate checks actual installed package manifests for pinned TypeScript, Prisma, Prisma Client/adapter, bcrypt and sharp versions, verifies the frozen lockfile still matches and emits a bounded JSON status. This is dependency **installation only**, not application runtime execution or a security attestation of npm package publishers. `--ignore-scripts` prevents installation hooks, but a package manager still parses package metadata from third parties.

## Isolation, limits and expected failures

Docker runs with `--network=none`, `--read-only`, nonroot UID/GID 65534, no-new-privileges, all capabilities dropped, IPC disabled, 2 CPU, 5 GiB memory cap, 128 PIDs, three read-only input binds, and noexec nodev nosuid private tmpfs for working files, results and temporary storage. The standard `runner.mjs` protocol and NestJS app have no access to this CI entrypoint.

CI verifies actual Docker configuration/mounts and checks no container is left after running. Negative probes must reject a modified source file and an empty dependency store; no source files are edited.

**Remaining blockers:**

- Native/prebuilt binary suitability is **not validated or built**. In particular `bcrypt`, `sharp`, Prisma engines and their platform components require separate design and verification.
- The generated Prisma Client at `apps/api/src/infra/database/generated/prisma` is not produced; it requires a controlled generator step into private writable storage.
- This offline install does not typecheck API source, run unit/integration/e2e tests, connect to PostgreSQL or exercise user-supplied Codex code.
- No one-time execution grant is consumed; actual `API_TYPECHECK` will require a separately reviewed fixed executor and fresh operator authorization.
- The official source is pinned and public; immutable Git object IDs and lockfile SRI establish correspondence with reviewed inputs, not a blanket security guarantee.

**Next:** separately review native/Prisma artifacts and generating the client entirely inside a private filesystem. Only afterward integrate a narrowly scoped `API_TYPECHECK` into the existing consent policy, without automatic PR merge. Docker Desktop on the user's Windows machine still needs independent validation.
