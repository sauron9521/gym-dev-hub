# PR #19 — Fixed task runner policy preview

This milestone creates a **non-executing review surface**, not a test runner. It is the next step after the safely staged one-file worker of PR #18. A `pnpm` script can execute arbitrary repository code, so **it must never run inside the current minimal Alpine read-only worker or the NestJS host process**.

## Supported repository and recipes

Only `sauron9521/gym-platform` is permitted. The following **fixed** commands are based on the repository's current root and app package scripts:

| Recipe ID | Future argv |
| --- | --- |
| `API_TEST` | `["pnpm", "--filter", "@gym/api", "test"]` |
| `API_TYPECHECK` | `["pnpm", "--filter", "@gym/api", "typecheck"]` |
| `API_LINT` | `["pnpm", "--filter", "@gym/api", "lint"]` |
| `WEB_TEST` | `["pnpm", "--filter", "@gym/web", "test"]` |
| `WEB_TYPECHECK` | `["pnpm", "--filter", "@gym/web", "typecheck"]` |
| `WEB_LINT` | `["pnpm", "--filter", "@gym/web", "lint"]` |

The client can select one recipe ID and the worktree fingerprint only. It cannot provide `argv`, executable, flags, cwd, host paths, environment variables, or `shell`.

## How the preview works

1. Open the local Agent Workspace, prepare an authorized, hydrated SHA-pinned worktree, and run its **current** integrity check.
2. Choose a recipe under **Task Runner Policy**.
3. The browser POSTs only `{ "recipeId": "API_TEST", "fingerprint": "sha256:..." }` to `/workspace/sessions/:sessionId/worktree-plans/:planId/task-preview`.
4. NestJS checks that the session/plan belongs to the approved repository, the commit SHA and fingerprint match, and a fresh Git integrity verification succeeds. It returns a **preview-only** contract with fixed `argv`, `/workspace` working directory, and the proposed sandbox limits.
5. No Docker command, Git mutation, background job, process spawn, approval token, or write to the local session store occurs. `executionEnabled=false`, `approvalGranted=false`, and `runnerImageAvailable=false`.

The proposed sandbox describes **requirements for future implementation**, not an implemented security boundary: no network, no Docker socket, read-only source, private ephemeral writable area, no secrets, non-root UID, 600-second timeout, 2 GiB RAM, 2 CPUs, 128 PIDs, and 64 KiB output cap. These limits **are not applied to any executable** in PR #19.

## Mandatory follow-on work before execution

- Design and build a separately pinned, locally trusted Node/pnpm runner image and immutable dependency strategy.
- Account for dependency lifecycle scripts, native modules, Prisma generators, and tests that expect databases, filesystem writes or network access.
- Keep the repository source read-only; use a private writable overlay/tmpfs for generated files, caches and test output. Validate volume mount identities and Docker policies after launch.
- Never expose host credentials or Docker socket to the runner; no network by default.
- Require a **new, independent, single-use operator approval**, tied to recipe, worktree commit, fingerprint and deadline. Never turn a preview into an execution grant.
- Stream bounded logs, enforce limits and stop/container cleanup with proper failure audit; only then introduce a fixed-command execution endpoint.
- Maintain **manual owner review and merge**.

This local prototype has no user login. Do not expose `localhost:3100/3101` to untrusted networks or treat a green preview as approval to merge.
