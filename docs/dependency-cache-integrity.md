# PR #22 — Pinned content-addressed dependency cache integrity

This milestone implements a **real SHA-512 integrity-verification and cache-staging proof**, but only for a small reviewed npm archive. The regular task runner, its execution-disabled protocol and PR #19 preview are unchanged. **Gym Platform's actual packages are not downloaded, installed or executed here.**

## Trust model

- A deterministic npm-style `.tgz` is committed as ASCII Base64 at `packages/runner/fixtures/cache/cache-fixture.tgz.b64`. The archive contains only two harmless package files.
- Its manifest `cache-manifest.json` contains the package identity, filename, size and SRI (`sha512-<base64>`). The manifest and archive are **untrusted together**: an attacker could change both.
- The trusted SHA-512 SRI is **independently pinned in the reviewed `cache-verify.mjs` inside the Docker image**. The tool rejects even a forged manifest whose new SRI matches altered bytes. In a production system, this trust root must come from a reviewed, commit-pinned dependency policy and image provenance, not from arbitrary user-controlled lockfile content.
- The tool accepts no CLI arguments. File names, package identity and size cap are fixed. It checks that the two inputs are regular non-symlink files before reading and canonicalizes the Base64 representation. The compressed bytes must match the pinned SHA-512, gzip header and exact byte length.
- Only then does it exclusively create `/cache/sha512-<hex>.tgz` inside a disposable, non-executable Docker tmpfs, with permissions `0600`. It re-reads the file and confirms it exactly matches the verified bytes before reporting success.
- The archive is **never extracted or interpreted**. The tool never calls pnpm, npm, shell scripts or package lifecycle hooks. It never populates a shared host cache, mounts a real repository or sends credentials to the container.

## Verified Docker isolation

The dedicated `dependency-cache-integrity.yml` workflow builds the Node 24/pnpm 12 image, then runs the fixture verifier with non-root UID 65534, `--network=none`, read-only rootfs, no capabilities, no-new-privileges, 2 GiB/2 CPUs/128 PIDs and no Docker socket. It exposes exactly **one reviewed read-only fixture bind** at `/input` and two private `noexec` tmpfs directories (`/cache`, `/tmp`). The workflow checks the requested and observed Docker mount policy, the structured JSON result, the cache digest, process exit code and removal of the disposable container.

It also runs three isolated negative tests that **must fail**:

1. Archive bytes changed but manifest unchanged.
2. Archive bytes changed **and** its manifest SRI recomputed to match the malicious bytes (still rejected by the image-pinned SRI).
3. A symlink replacing the expected archive input.

Hosted Linux Docker CI demonstrates the intended boundary; real Home-PC Windows Docker Desktop remains unverified.

## Cache scope and next milestone

The proof checks one **compressed archive**, not the full integrity of npm package extraction, `node_modules`, or a production pnpm content-addressed store. It does not parse the real `gym-platform/pnpm-lock.yaml`, audit registry origins, resolve tarball URLs, verify signatures or authorize package downloads.

For real Gym Platform we still need:

- A reviewed **commit-pinned lockfile and package manifest** with all expected archive SRI hashes, package sources and native dependency/build-script policy. Compare actual archive bytes against those hashes before accepting cache entries. Do not accept a lockfile controlled by an untrusted agent as its own trust authority.
- Separate, vetted **online cache population** using an allowlisted registry with strict credential isolation. Keep offline test execution network-disabled.
- Quarantined archive extraction, path-traversal/symlink checks, no package hooks, filesystem ownership checks and a disposable writable dependency tree. Avoid sharing an unpacked or executable package cache across trust domains.
- A separately approved, narrow native-build solution for Prisma engines, bcrypt, esbuild, SWC and other allowed build steps; `--ignore-scripts` may leave these unusable.
- A new per-recipe, single-use operator grant, bounded test output/time, verified runtime mounts and cleanup before running a real project `typecheck` or `lint`. Manual owner merge remains mandatory.

Nothing here enables arbitrary project commands or modifies `gym-platform`. Review `packages/runner/cache-verify.mjs`, the pinned hash and GitHub Actions on the **final PR head SHA** before manually merging.
