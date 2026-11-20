# PR #31 — API_TYPECHECK dependency provisioning gate

This PR adds a **read-only, CI-only readiness gate** for a future real Gym Platform `API_TYPECHECK` run. It advances beyond the small test fixtures and isolated scratch filesystem by analyzing the **actual direct dependency graph of `apps/api`** and identifying the exact missing requirements for an offline TypeScript check. **It neither provisions the full dependency cache nor executes `pnpm`, Prisma, native binaries, API code or TypeScript.** The normal Hub API, Codex adapter, task preview, and diagnostic runner remain non-executing.

## Immutable trusted inputs

The workflow checks out public `sauron9521/gym-platform` at pinned commit `7104f723c4ee7b81e7b9b64e9c9483aea344ef7a`, Git tree `2c140e1e740b3dd8cc7582db726f46b54b73b334`, the same source snapshot as PR #28/#29/#30. The eight inputs are verified individually against independent Git blob SHAs before the script reads them:

- Root `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` (both pnpm 12 lockfile documents).
- `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`.
- `apps/api/prisma7.config.ts`, `apps/api/prisma/schemas/schema.prisma`.

The script rehashes those eight files itself, disallows symlinks and oversized files, and accepts only the fixed `.audit/gym-platform` checkout path. It reuses the existing PR #23 `auditLockText` (1,631 SHA-512 registry resolutions) and `auditWorkspaceText` (exactly reviewed `allowBuilds` and audit exception).

## What is checked

The gate resolves **every declared direct dependency and dev dependency of the actual `apps/api` importer** in the *application* document, not the pnpm-toolchain document. For each dependency it checks the manifest specifier, exact importer resolution, matching registry package entry and SHA-512 integrity. The output includes the resolved version and integrity for each package; the actual version may differ from the requested semver range.

Additional reviewed pins include:

| Required package | Resolution |
| --- | --- |
| `typescript` | `6.0.3` |
| `prisma`, `@prisma/client`, `@prisma/adapter-pg` | `7.10.1` |
| Transitive `@prisma/engines` | `7.10.1` |
| `bcrypt` | `6.0.0` |
| `sharp` | `0.35.5` |
| `@types/node` | `26.6.6` |

The API recipe must remain **`tsc --noEmit -p tsconfig.build.json`**, not a caller-provided shell command. Its TypeScript config is checked for strict NodeNext resolution and the generated `#prisma/*` alias. The Prisma generator must remain `prisma-client`, output into `apps/api/src/infra/database/generated/prisma`, and use the reviewed `prisma/schemas/` location.

Native build permissions in the *source repository* include `@prisma/engines`, `prisma`, `bcrypt`, `esbuild`, `@swc/core`. This describes existing policy; **the Hub does not execute those hooks**. Denied `@parcel/watcher` and `@scarf/scarf` builds remain denied. Some packages such as `sharp` may rely on platform-specific prebuilt binaries and require separate provisioning review even without a lifecycle script.

## Fail-closed output

The JSON plan reports `provisionReady: false`, `executionEnabled: false`, `typecheckExecuted: false`, `installExecuted: false` and four explicit unsatisfied prerequisites:

1. Build a reviewed **complete offline cache** for the API dependency graph and its transitive packages.
2. Validate a dedicated native/prebuilt binary strategy (Prisma, bcrypt, sharp and other platform packages).
3. Generate Prisma Client **inside private writable storage**, never into the Git-pinned source bind.
4. Consume an explicitly granted, still-valid **single-use** operator capability just before any actual task execution.

The proposed future installer is limited to the fixed `pnpm install --offline --frozen-lockfile --ignore-scripts` arguments. This is **a proposal, not an executed operation or proof that it will succeed**. `pnpm 12` offline policy metadata, the hoisted node linker, Prisma generation, and platform-specific modules require their own tested implementation; these cannot be waived merely to get a green workflow.

## Tests and future work

Hub unit tests reject changed importer specifiers/versions, missing SHA-512 entries, suspicious local/remote dependency protocols, duplicate declarations, altered TypeScript recipe, unsafe tsconfig changes and changed Prisma generator/output. The dedicated CI checks the actual reviewed Git commit and exercises seven changed-source negative cases plus arbitrary-path rejection. The runner is **never** given `node_modules`, secrets, Docker socket or execution instructions in PR #31.

The next PR should provision a **bounded reviewed API dependency closure** in a temporary trusted CI network stage, independently validate its integrity, and pass the resulting store to the existing networkless read-only source/private tmpfs proof; separately design generated Prisma and native binaries. No automatic GitHub merge.
