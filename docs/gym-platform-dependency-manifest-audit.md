# PR #23 — Read-only audit of the actual Gym Platform dependency manifest

This PR is the first step that **inspects real files from `sauron9521/gym-platform`**, not synthetic package fixtures. It is a static, deliberately non-executing supply-chain review. It does not install dependencies, build native modules, run project scripts, modify Gym Platform or create/merge its PRs.

## Immutable source snapshot

The CI workflow checks out this exact public Git commit in a separate temporary directory, with no persisted GitHub token:

```text
sauron9521/gym-platform
73b636f5d064c7f24b43607e0c8411e9161f8986
```

The Node audit script **independently verifies Git blob identities** for exactly these five files before trusting their contents:

| Path | Trusted Git blob SHA-1 |
| --- | --- |
| `pnpm-lock.yaml` | `994456e853beaa556ab5a0d5ee3533b8f7db5682` |
| `pnpm-workspace.yaml` | `0af4a0308ad0b25ea1813badb71b09b0256b6513` |
| `package.json` | `4fa06500522abaa2fc809d022e3c4f74267a8d67` |
| `apps/api/package.json` | `314142f3577c0620ff3402b7de3d25ef9702a5f4` |
| `apps/web/package.json` | `4bba19980d8d53075cac8774e1fd6de7e2720dbf` |

The script reads regular files only; it rejects symlinks, altered content, unexpected size or invalid Git object hashes. It never executes `pnpm`, `npm`, `git`, `sh` or code supplied by Gym Platform. CI uses `git rev-parse` solely to independently confirm the pinned commit/blob IDs.

**This is a point-in-time snapshot audit, not a claim about GitHub `main` after the pinned commit.** To audit a newer Gym Platform commit, update all reviewed Git SHA and blob pins in a separate PR.

## What the real manifest contains

The pinned `pnpm-lock.yaml` is approximately 742 KB and contains **two YAML documents**, which must both be audited. The first covers the package-manager dependency graph; the second contains the main project dependency graph. For this pinned snapshot the expected results are:

| Area | Expected |
| --- | --- |
| Package manager | `pnpm@12.18.0` |
| Lockfile documents | 2, both version `9.0` |
| First document | 15 package resolutions |
| Second document | 1,616 package resolutions |
| Total | **1,631** SHA-512 integrity entries |
| Native/install build allowances | 5 explicitly allowed, 2 explicitly denied |
| Advisory suppressions | 1 existing exception, recorded for review |

The script checks all package entries in both documents and rejects missing, malformed, non-SHA512 and duplicate resolutions, suspicious custom resolution formats, and unsafe importer sources (`file:`, `git:`, custom HTTP tarballs). SHA-512 SRI pins in a lockfile make fetched artifact substitution detectable **if the lockfile itself is trusted**, but this audit does *not* fetch those artifacts or verify their actual bytes. Git blob SHA-1 pins identify the reviewed source snapshot, not the cryptographic trust of an npm publisher.

## Actual `allowBuilds` policy

The pinned workspace allows these package lifecycle/build hooks when normal installation is permitted:

- **Allowed:** `@prisma/engines`, `prisma`, `bcrypt`, `esbuild`, `@swc/core`.
- **Denied:** `@parcel/watcher`, `@scarf/scarf`.

These are **reported and checked**, *not executed* by this PR. The security audit configuration currently includes `GHSA-fc5q-39xc-vjpf` as an ignored advisory. We explicitly report this exception; **its presence is not evidence that the vulnerability is fixed or safe**. Adding a new suppression or changing any build allowance causes this pinned policy audit to fail until reviewed.

## Automated checks

- Existing Hub CI runs tests on invalid/missing integrity, duplicate package entries, forged source protocols, changed build allowances and changed advisory suppressions.
- New `Gym Platform Pinned Dependency Audit` GitHub workflow checks out the exact public Gym Platform commit, verifies original Git object hashes and runs the static audit using Node.js 24 only. No `pnpm install`, compilation, DB access or code execution from the target repository occurs.
- The workflow asserts the exact result and then mutates the downloaded lockfile to ensure the independent Git blob pin rejects the modified copy.
- All report outputs are non-sensitive summaries. No registry tokens are injected.

## Limitations and next step

This script statically recognizes the **reviewed pnpm 12 lockfile shape** rather than attempting to implement a complete general-purpose YAML parser. It is intentionally fail-closed on structural changes. Its checks do not independently audit every nested snapshot dependency edge, verify runtime license/vulnerability status, check actual package tarball bytes, populate a trusted npm registry cache, or authorize any native build or test command.

Next: design a commit-bound package cache manifest, verify real downloaded tarballs against the pinned SHA-512 hashes in a separate credential-isolated provenance step, and define a narrowly reviewed native-build allowlist. Then proceed to disposable source/dependency overlays and separately consented fixed test recipes. **No automatic merge.**

Local Windows Docker Desktop remains unverified while Home-PC is offline.
