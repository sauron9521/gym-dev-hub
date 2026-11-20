# Post-Hydration Integrity & Inert Worker Mount Preflight (PR #14)

This PR adds **read-only integrity checking only**. It does **not** perform a Docker mount, execute Codex, modify worktree files or create an execution permission. The existing isolated worker in PR #8 still starts with **no host mounts** and supports only HELLO/PING/SHUTDOWN.

## Scope

After the separately authorized PR #13 hydration, Workspace offers **Звірити з Git**. The API returns a point-in-time report in one of three states:

- `verified`: every checked-out file matches the exact raw Git blob at the pinned commit, the tree contains no unexpected or missing files/directories, counters match and Git registration passes the original read-only inspector
- `mismatch`: modified, removed, added, oversized, special, redirected or otherwise unexpected objects are present; also used when Git metadata or inspection fails
- `not-ready`: hydration has not completed successfully (including `running` / `failed` states)

The implementation first invokes the PR #11 read-only inspector to recheck allowed local repository origin, worktree root, pinned commit, common Git directory, expected branch and metadata pointer. For a hydrated worktree the inspector's expected nonempty warning is explicitly accounted for, **but any additional finding blocks success**.

The new verifier reads only `git ls-tree -r -l -z --full-tree <pinned SHA>` to obtain trusted Git tree metadata. It uses the existing path scanner for mode, name, size, symlink, submodule, reserved Windows names, case/Unicode collisions and limits. It enumerates the actual filesystem tree; any unknown directory, symlink/junction, special object, extra or missing file blocks verification. File contents are streamed in bounded **64 KiB chunks** and hashed with the standard Git blob header (`blob <byteLength>\\0`) using SHA-1 or SHA-256 according to the object ID length. No Git checkout, filter, hooks or Git content scripts are executed.

The report includes file count, verified byte count and a small sanitized list of findings. Limits follow the existing hydration policy: **5000 regular files**, **20 MiB per blob**, **100 MiB total**. Failure does not delete, repair, overwrite or quarantine anything.

## Mount preflight (preview only)

The same report contains a **fixed proposed mount policy**:

| Attribute                   | Value                                                  |
| --------------------------- | ------------------------------------------------------ |
| Host source                 | Exact worktree target from the locally stored manifest |
| Container target            | `/workspace`                                           |
| Read-only                   | `true`                                                 |
| Network enabled             | `false`                                                |
| **Mount enabled**           | **`false`**                                            |
| **Agent execution enabled** | **`false`**                                            |

This is a structural preview, **not** verification that a Docker engine supports the mount. No Docker CLI commands are run, no container mounts are created and no approval token is issued. A successful integrity response **cannot** be passed to any new execution endpoint, because this PR does not add one. A future mount-enabled operation must check the current Docker boundary, revalidate the entire worktree at the moment of use, require a fresh independent operator approval and restrict the actual mount. Treat a green report as diagnostic only, never as an authorization.

## HTTP and UI

```http
GET /workspace/sessions/:sessionId/worktree-plans/:planId/integrity
GET /api/workspace/sessions/:sessionId/worktree-plans/:planId/integrity
```

NestJS scopes the plan to the requested session, and the Next.js same-origin proxy explicitly allowlists **GET only**. No arbitrary filesystem paths, shell commands, host mounts or credentials are accepted in the request.

Within Workspace, **Звірити з Git** appears after `hydrationState=completed` and shows the integrity result and inert mount preview. The previous empty-worktree inspector still correctly reports `needs-review` after hydration.

## Testing and constraints

Temporary real-Git fixtures cover text and binary blobs, byte-level tampering, extra directories, missing files, pre-hydration status, cross-session access, file counts and unchanged source working tree. The dedicated GitHub Windows workflow runs these tests alongside Linux CI. The user's Home-PC remains offline; the hosted runners do **not** establish on-device compatibility.

This is an **observational** read-only check. Local untrusted administrators/processes can change a file after it has been read, and the filesystem API does not guarantee race-free inspection against malicious concurrent modifications. Do not expose Dev Hub beyond localhost or treat this as a cryptographic authorization token for future mounts.

## Next

PR #15 should prepare **separately approved, scoped read-only worker mounting** with a fresh integrity validation at action time and full Docker safety preflight. Codex execution, shell commands, write privileges, cleanup and GitHub merges remain separate later PRs. Merges are always manual.
