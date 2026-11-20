# PR #29 — One-time operator grants for a future fixed API typecheck

This is an **authorization foundation only**, not an executable Gym Platform task runner. It reuses the existing `TaskRunnerPolicyService.preview` from PR #19 (which already performs a fresh worktree integrity verification). It does **not** add Docker execution, package installs, source modification, push or merge endpoints.

## Default-deny configuration

The NestJS API remains bound to `127.0.0.1` by default. The new grant issuance feature is **disabled** unless the local operator explicitly configures both:

```text
DEV_HUB_ENABLE_TASK_GRANTS=true
DEV_HUB_TASK_GRANT_OPERATOR_SECRET=<independent 32–256 byte random secret>
```

Use an **independent** randomly generated secret, not the existing worktree-creation or Docker-worker secret. Do **not** commit it, put it into a URL, expose the API publicly or save it in browser localStorage. The optional `DEV_HUB_TASK_GRANT_AUDIT_FILE` controls the local audit path; by default only metadata is appended to `.local/task-grants.audit.jsonl`, with restricted file permissions. A failed audit write rejects issuing a token. If this file approaches 1 MiB, rotate it manually before further issuance (do not truncate an active audit without a backup).

Tokens are cryptographically random 32-byte values, returned **only once** when issued and stored **in memory by SHA-256 token hash**. They expire after **45 seconds**. Disabling the feature immediately invalidates outstanding tokens on the next request; an API restart also invalidates every pending token because raw bearer tokens and their hashes are not persisted.

## Scope: only one reviewed snapshot and one recipe

| Bound property                   | Reviewed value                                                     |
| -------------------------------- | ------------------------------------------------------------------ |
| Target                           | `sauron9521/gym-platform`                                          |
| Recipe                           | `API_TYPECHECK` only                                               |
| Fixed future argv (preview only) | `pnpm --filter @gym/api typecheck`                                 |
| Source commit                    | `7104f723c4ee7b81e7b9b64e9c9483aea344ef7a`                         |
| Git tree                         | `2c140e1e740b3dd8cc7582db726f46b54b73b334`                         |
| Source manifest SHA-256          | `dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b` |
| Worktree                         | Exact local session + plan ID + SHA-256 fingerprint                |
| Expiry                           | 45 seconds                                                         |
| Execution                        | **Disabled**                                                       |

The pinned Git commit/tree/manifest are exactly those audited in PR #28. This is intentionally a _snapshot-bound_ policy. A worktree based on a newer Gym Platform commit is **not eligible** for this grant until the relevant source manifest and approval policy are separately reviewed and updated.

Issuance requires the existing worktree to be fully hydrated, have fresh verified Git integrity, and pass the existing non-executing task preview. The new service checks that the returned recipe, all IDs, fingerprint, commit, fixed argv and proposed Docker restrictions exactly match the authorized policy. It does not accept arbitrary command arguments, scripts, paths or environment variables from the caller.

## HTTP lifecycle

**Issue (local operator only):**

```http
POST /workspace/sessions/:sessionId/worktree-plans/:planId/task-grant-authorize
Content-Type: application/json

{
  "recipeId": "API_TYPECHECK",
  "fingerprint": "sha256:<actual 64-char worktree fingerprint>",
  "sourceCommit": "7104f723c4ee7b81e7b9b64e9c9483aea344ef7a",
  "sourceTree": "2c140e1e740b3dd8cc7582db726f46b54b73b334",
  "sourceManifestSha256": "dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b",
  "confirmation": "I_APPROVE_API_TYPECHECK_ON_PINNED_SOURCE_ONLY",
  "operatorSecret": "<your separate local secret>"
}
```

Response contains one `grantToken`, random `grantId`, exact scope, `expiresAt`, and **`executionEnabled: false`**. Handle it as a sensitive bearer capability; never include it in error reports or GitHub issues.

**Revoke:**

```http
POST /workspace/sessions/:sessionId/worktree-plans/:planId/task-grant-revoke
Content-Type: application/json

{ "grantToken": "<issued token>", "operatorSecret": "<your separate local secret>" }
```

A matching token is invalidated before any asynchronous disk audit, so concurrent replay or revocation cannot reauthorize it. Wrong session or plan consumes the attempted token rather than granting access to a different target.

**Important:** there is no public `/task-grant-consume`, `/task-run` or `/execute` endpoint in this PR. The internal `consumeForPolicyCheck` method is covered by unit tests only: it atomically removes a capability, then checks the live task-preview policy _again_ and returns `consumed-no-execution` / `executionEnabled: false`. No caller can trigger a Docker process by submitting a grant. Future execution will require separate reviewed design and a new explicit authorization flow.

## Audit and safety properties

The append-only JSON Lines file records `issued`, `revoked`, `consumed` and `consume-denied` events, with timestamps, random grant IDs and non-secret scope metadata. It **never stores** the bearer token, operator secret, command arguments, local source path, environment variables or project file contents. Issued entries carry enough information to infer the grant's short expiry. No token is considered valid after process restart.

Negative unit tests enforce: opt-in and strong operator secret, strict schema and recipe selection, forged commit/tree/manifest rejection, wrong repository/worktree/fingerprint, unsafe Docker boundary, wrong process argv, replay/concurrent consumption, revocation, expiry, wrong session/plan, secret-free audit, invalid audit file symlinks, source drift on consume, and invalidation after disabling.

## Limitations and next step

This is a **single-process, localhost-only** authorization prototype, _not_ a distributed permission service. A new process cannot recover outstanding grants, and audit durability depends on the local filesystem. NestJS currently has no user login or per-session identity enforcement; the operator secret is a mandatory local control, **not** a substitute for proper authentication if the API is ever exposed to other machines. Avoid logging request bodies in proxies or development middleware.

A future PR must implement an isolated fixed-command runner with a **private writable dependency overlay**, reviewed native/Prisma provisioning, a fresh operator consent and actual secure sandbox policy, bounded logs/timeouts and explicit cleanup. It must bind the new executor to a still-current, verified source snapshot and safely consume the intended grant **before** any side effect. Do not infer executor readiness from a green authorization test. Manual GitHub merge remains mandatory.
