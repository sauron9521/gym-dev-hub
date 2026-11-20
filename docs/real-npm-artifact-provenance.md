# PR #24 — Verified real npm artifact in a networkless, ephemeral Docker cache

This is the first **genuine downloaded npm dependency** from the independently audited `sauron9521/gym-platform` monorepo, not a generated fixture. The proof remains intentionally limited to **one exact, public tarball** and does not authorize installing packages or running commands from Gym Platform.

## Immutable provenance and trust roots

The GitHub Actions workflow checks out `sauron9521/gym-platform` at **commit `73b636f5d064c7f24b43607e0c8411e9161f8986`**, with `persist-credentials: false`. It runs the existing static manifest audit from PR #23, which independently checks all five reviewed Git blobs, including the 742 KB lockfile (`994456e853beaa556ab5a0d5ee3533b8f7db5682`).

That trusted lockfile contains an exact registry dependency:

| Attribute | Value |
| --- | --- |
| Package | `is-number@7.0.0` |
| Fixed public source | `https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz` |
| SHA-512 | `sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==` |
| Source repository commit | `73b636f5d064c7f24b43607e0c8411e9161f8986` |

The CI checks that the exact `is-number@7.0.0` lock entry exists **once**, with exactly that SRI, and then downloads **only this fixed URL** over HTTPS into a disposable GitHub-hosted runner staging directory. No registry credentials or GitHub token are persisted for this step. Curl permits no redirects. **The network is available for this tightly scoped trusted CI fetch only**, not for the Docker verification stage.

The downloaded artifact's SHA-512 is checked in the trusted host CI step **before it reaches Docker**. The reviewer-owned Docker image then independently verifies the same compiled-in SRI using constant-time digest comparison. The verifier does not take arbitrary arguments, paths, URLs, environment overrides, package names or hashes from the caller.

## Real offline cache staging

The CI starts a disposable Docker container from the reviewed Node.js 24/pnpm 12 image, with:

- `--network=none`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--user=65534:65534`, `--ipc=none`
- 2 GiB memory, 2 CPUs, 128 PIDs and bounded filesystem/output sizes
- Exactly one read-only bind mount of the reviewed tarball staging directory at `/input`; no repository source, secrets or Docker socket
- A private, disposable `/cache` noexec tmpfs and `/tmp` noexec tmpfs

Only `/usr/bin/node /opt/gym-dev-hub/real-artifact-verify.mjs` runs in this proof, **not** `pnpm install`, `npm install`, a project script, or an extractor. The verifier confirms regular non-symlink bytes, bounded size, gzip header and exact SHA-512, writes `/cache/sha512-<digest>.tgz` using exclusive creation, reads back and compares the data, then emits a bounded JSON result. The container and temporary host directories are removed in both success and error paths.

Two negative isolated Docker cases must fail closed:

1. An archive with one byte modified.
2. A symlink replacing the expected tarball path.

## Important limitations

**This is not a complete provenance attestation.** An SRI hash proves correspondence with the *reviewed lockfile bytes*, not that the npm publisher or upstream code is trustworthy. No signing/transparency-log or vulnerability status checks occur. The runner image's Alpine and npm build-time dependencies are also not yet fully pinned.

This one-package demonstration does **not** check all 1,631 lockfile entries, populate a reusable pnpm store, extract a tarball, allow npm lifecycle hooks, build Prisma/native dependencies, or execute a Gym Platform lint/typecheck/test recipe. A true offline workspace provisioner will require a fixed, reviewed artifact manifest; trusted cache acquisition; cross-platform/native build policy; safe extraction; immutable source and private writable dependencies; a per-recipe operator approval token; strict limits and cleanup; and manual PR merge.

The ordinary `runner.mjs` protocol continues to reject `RUN` and `INSTALL`. No new NestJS endpoint, frontend execution action, unrestricted command runner or persistent shared cache is introduced. Home-PC Docker Desktop still needs separate local verification.

## CI acceptance

Confirm on the **final PR head SHA** that standard Hub CI, the existing Node runner, offline fixture and cache fixture workflows, and the new `Real npm Artifact Provenance` workflow all pass. Never treat this as a successful check of Gym Platform's native build or tests.
