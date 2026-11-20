# PR #25 — Two real npm dependencies installed offline, without scripts

This PR extends the immutable Gym Platform lockfile audit (PR #23) and the verified one-tarball provenance proof (PR #24). It demonstrates the **first real transitive npm dependency graph installation in a networkless, disposable Docker container**. It is deliberately scoped to two public, small, pure-JavaScript packages and is **not** a Gym Platform build.

## Reviewed graph and trust

The separate trusted GitHub Actions job checks out `sauron9521/gym-platform` at `73b636f5d064c7f24b43607e0c8411e9161f8986`. It reruns the PR #23 manifest audit, including its five independently pinned Git blobs, then asserts that the following **exact SHA-512 SRI strings** occur once each in that lockfile and in the checked-in tiny fixture:

| Package                | Role       | SHA-512 SRI                                                                                       |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `to-regex-range@5.0.1` | Direct     | `sha512-65P7iz6X5yEr1cwcgvQxbbIw7Uk3gOy5dIdtZ4rDveLqhrdJP+Li/Hx6tyK0NEb+2GCyneCMJiGqrADCSNk8sQ==` |
| `is-number@7.0.0`      | Transitive | `sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==` |

`to-regex-range` depends on `is-number ^7.0.0`. The small reviewed fixture has a pnpm v9 lockfile, exact package versions, `pnpm@12.18.0`, and deliberately forbidden root `preinstall`, `install`, `postinstall`, and `prepare` marker scripts.

**Networked trust phase:** GitHub-hosted CI runs `pnpm fetch --frozen-lockfile --ignore-scripts` from this fixture and populates a **new temporary pnpm store**. There are no registry credentials passed from Hub, and no project scripts are run. pnpm 12 records one project-index symlink back to the trusted CI workspace. The fetch step verifies that exact target, removes this _bookkeeping-only_ link, discards the generated virtual `node_modules`, and rejects all remaining symlinks. The resulting self-contained store must be less than 64 MiB and contain at most 4,096 files. The host files are discarded after the job.

**Networkless install phase:** Docker runs `/opt/gym-dev-hub/offline-real-pair.mjs` as UID/GID `65534:65534`. The container accepts no user parameters and receives **two read-only host inputs**: the approved fixture `/input` and temporary fetched store `/store`. A strict filesystem scan rejects store symlinks, unusual entries, excessive depth/size/file counts. It copies the fixture and store into an ephemeral `/workspace` tmpfs, then calls a **fixed argv**, not a shell string supplied by the browser:

```text
/bin/sh /usr/bin/devhub-pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir /workspace/.pnpm-store
```

For pnpm 12, `--trust-lockfile` prevents a _redundant_ supply-chain policy metadata lookup that otherwise fails offline. It is used **only after the verifier independently checks the exact Git blob SHA-1 identities of all three fixture files** and the two SHA-512 package pins against the reviewed Gym Platform commit; it does not disable package-byte integrity validation. Do **not** apply this flag to an unreviewed or agent-edited project lockfile. This `/bin/sh` invocation is only to run the reviewed global pnpm shim; `shell: false` is used by Node `spawnSync`, and **no input can inject another shell command**. The pnpm shim was installed and checked in the trusted runner image. The maximum pnpm runtime is 60 seconds, with 16 KiB captured output.

After installation, the verifier **reads package metadata without loading or executing the packages** and confirms the exact direct `to-regex-range@5.0.1`, transitive `is-number@7.0.0`, and `^7.0.0` dependency declaration. It asserts that the locked input bytes did not change and that none of the four lifecycle marker scripts executed.

## Container boundary

- `--network=none`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--ipc=none`
- Nonroot `65534:65534`, `--pids-limit=128`, `--memory=2048m`, `--cpus=2`
- Only two reviewed _read-only_ mounts at `/input` and `/store`; no GitHub token, repository source, Docker socket or secret mounts
- Private `noexec` tmpfs at `/workspace` (128 MiB) and `/tmp` (64 MiB)
- Fixed entrypoint with no API or user-configurable arguments; explicit cleanup and container state checks in CI
- Negative tests: tampered fixture SRI and an empty store must both fail, without network fallback

## Explicit limits

This **does not** prove that the full 1,631-package Gym Platform dependency graph can be installed offline. It does not handle Prisma-generated output, bcrypt, SWC, esbuild, other native/build hooks, package binaries or a database. It does not allow Codex to execute files or invoke arbitrary commands, and the ordinary `runner.mjs` still only accepts diagnostic messages.

Real package publication cannot be deemed trustworthy solely because its SRI matches a reviewed lockfile; a malicious publisher could have produced the original tarball. This test uses a simple private temporary store, not a persistent reusable signed software-supply-chain cache, and cannot attest to the absence of all possible attacks inside package-manager implementations. The trusted network fetch and Docker image build have different security boundaries. Home-PC Windows Docker Desktop remains to be tested locally.

**Next:** a narrowly reviewed, commit-pinned offline store for the relevant Gym Platform toolchain; safe native-build provisioning; immutable read-only source with private writable overlays; new single-use, recipe-bound operator approval for actual lint/typecheck/test commands; then PR preparation with manual merge. Do not expose the unauthenticated Hub to public networks.
