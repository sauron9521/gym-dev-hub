# PR #30 — Disposable writable scratch volumes with immutable source

This PR demonstrates an **isolated filesystem layout for a future Gym Platform task runner**, without actually executing a Gym Platform task. It is a CI-only, networkless Docker preflight and **does not expose a new NestJS API, Codex tool, task execution permission or package install endpoint**. It builds directly on the Git-verified full-source snapshot proof from PR #28 and the separate, default-disabled authorization foundation from PR #29.

## Layout and provenance

The CI job checks out only the reviewed public Gym Platform commit `7104f723c4ee7b81e7b9b64e9c9483aea344ef7a`, verifies Git tree `2c140e1e740b3dd8cc7582db726f46b54b73b334`, creates the 1,258-file tracked-only archive and a NUL-delimited tree manifest with independently pinned SHA-256 `dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b`.

Inside the disposable Docker container:

| Path         | Mount                                                  | Purpose                                                                |
| ------------ | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `/source`    | Read-only bind                                         | Exact tracked Gym Platform Git snapshot, not `.git` or untracked files |
| `/manifest`  | Read-only bind                                         | Independently hash-pinned Git tree manifest                            |
| `/workspace` | Independent `rw,nodev,nosuid,noexec` tmpfs, **64 MiB** | Private `dependencies/`, `cache/`, `generated/` proof files            |
| `/results`   | Separate `rw,nodev,nosuid,noexec` tmpfs, **16 MiB**    | Private `reports/preflight.jsonl`                                      |
| `/tmp`       | `rw,nodev,nosuid,noexec` tmpfs, **16 MiB**             | Isolated Node runtime temporary space                                  |

This is **not an overlayfs union mount**: target source and scratch are deliberately separate; no relative folder overlay or dependency resolution is enabled yet. The full tracked source is never copied into the writable area. Real native packages, Prisma generation and any command requiring a writable project layout remain future work.

## CI-only fixed preflight

The new `packages/runner/overlay-preflight.mjs` runs only from a reviewed fixed-image entrypoint. It accepts **no runtime arguments**. First, it checks Linux `/proc/self/mountinfo` for exact read-only source and manifest mounts and independent non-executable, device-free, suid-free writable tmpfs mounts; checks `statfs` confirms tmpfs and that workspace/results have different filesystem device identifiers. Second, it invokes the already reviewed fixed `full-source-audit.mjs` with a hardcoded Node executable and no user-controlled parameters. That child hashes **all 1,258 tracked source files**, verifies mode/size against the independent manifest and rejects any extra, missing, symlinked or altered source entry.

Only after source verification, the proof writes tiny **hardcoded harmless text files** to a private `/workspace` scratch area, confirms exclusive file creation and exact readback, and writes a bounded JSON report to the independent `/results` tmpfs. No Gym Platform code is imported or executed, no `pnpm` invocation occurs, and no project scripts/lifecycle hooks run. The fixed Node CI script itself executes inside the sandbox, but is not a user/agent task.

The ordinary `runner.mjs` still rejects `RUN`, `TEST` and `INSTALL`; PR #29 operator grants still have **no consumer route or execution mechanism**.

## Container and adversarial checks

GitHub Actions builds the pinned runner image, launches the proof as nonroot UID/GID `65534`, validates Docker HostConfig and actual bind mount identities, and limits execution to:

- `--network=none`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--ipc=none`.
- 512 MiB RAM, 1 CPU, 128 PIDs, no host Docker socket, repository credentials, secret mounts, background services or privilege escalation.
- Exactly two read-only host binds, plus three private `noexec` tmpfs directories with explicit size limits.

The positive case runs **twice in separate Docker containers**; the preflight asserts scratch directories are empty before every run so previously generated data cannot leak across instances. The first container is deleted, and the second must independently succeed. Six negative scenarios must **fail closed**: missing workspace mount, missing results mount, executable workspace mount, executable results mount, modified source file, tampered Git manifest. Host source/manifest inputs remain unchanged during the proof.

**Important limitation:** `noexec` does not prevent an interpreter (e.g., Node or Python) from evaluating scripts stored on a volume. This PR does not claim noexec by itself makes arbitrary code safe. It is only one control in the future execution design. Runtime limits and Docker isolation reduce exposure but are not a formal escape-proof security boundary. Git hashes tie the source to a reviewed commit; they do not attest the publisher's intentions.

## Next milestone

A future PR will need a separately reviewed **actual fixed runner recipe** with a pinned full dependency/native-build strategy, a private writable project layout that cannot mutate the source, fresh one-time operator consent bound to the same source identity, bounded logs/timeouts and guaranteed cleanup. A green preflight does **not** authorize a TypeScript check, source modification, Git push or PR merge. All merges remain manual, and Windows Docker Desktop still needs independent local validation.
