# Worktree Manifests and Explicit Plan Acknowledgement (PR #9)

This slice adds **planning and review only**. It does NOT create Git branches, worktree directories, run commands, mount repositories into Docker, or grant agent execution permissions. All GitHub merges remain manual.

## Setup

Standard local development starts from the repository root:

```powershell
cd F:\programer\gym-dev-hub
pnpm dev
```

Configure optional absolute local paths in `apps/api/.env`:

```dotenv
DEV_HUB_REPOS_ROOT=F:\programer
# DEV_HUB_WORKTREES_ROOT=F:\programer\gym-dev-hub\apps\api\.local\worktrees
# DEV_HUB_PLAN_FILE=F:\programer\gym-dev-hub\apps\api\.local\worktree-plans.json
```

By default, the API derives `DEV_HUB_REPOS_ROOT` as three levels above the `apps/api` working directory, so with normal `pnpm dev` it resolves to `F:\programer`. For non-standard layouts or process launch locations, set it explicitly. Plans are persisted locally in a versioned, gitignored JSON file. One API process owns the file; concurrent independent API instances are not supported.

## Worktree planning

Open `http://127.0.0.1:3100/workspace`, select a session bound to an allowed GitHub repository, and choose **Створити план**. The API checks:

1. Session exists, is not completed, and belongs to an allowlisted repository from `GITHUB_REPOSITORIES`.
2. Its local clone is directly inside the permitted `DEV_HUB_REPOS_ROOT` with a safe single directory name, not outside via a junction/symlink.
3. The clone has a real `.git` directory and an `origin` remote pointing to exactly the session's GitHub slug (HTTPS or SSH). Credentials and Git remote URLs are not exposed.
4. The planned target is under the dedicated `.local/worktrees` root, with a new server-generated UUID; existing target and unsafe root symlinks are rejected.
5. A unique proposed `devhub/task-<uuid>` branch and SHA-256 fingerprint are calculated from `sessionId`, `repository`, `sourcePath`, `targetPath`, and `proposedBranch`.

The browser previews these immutable fields. Both the local repository and target directory remain unchanged. Plans support `pending`, `acknowledged`, `expired` and `revoked` states, with an audit list of created/acknowledged/revoked events. Only one non-expired active plan per session is allowed. At most 100 plans can be saved.

## Acknowledgement lifecycle

A user reviews the plan, checks a confirmation box, and clicks **Погодити план**. The API requires the **exact current fingerprint** and confirmation phrase `I_APPROVE_THIS_PLAN_ONLY`; a mismatch or duplicate acknowledgement is rejected. Pending plans expire after 15 minutes; acknowledgement also expires after 15 minutes. Expired or revoked plans cannot be reused; create a new plan. **Відкликати** records revocation in the local audit trail.

**This is not security-grade authentication or a reusable authorization grant.** Dev Hub still has no user login. A local process able to reach the HTTP API may spoof an acknowledgement; therefore no downstream operation is permitted based on this state. Worktree creation, mount authorization, AI execution, or Git writes will require fresh, authenticated and one-time approvals in later PRs. No execution/consumption endpoint exists here, and `executionEnabled=false`, `worktreeCreated=false` always.

## HTTP endpoints

All go through NestJS under `/workspace/sessions/:sessionId/worktree-plans`, and through the same-origin allowlisted Next.js proxy under `/api/workspace/sessions/:sessionId/worktree-plans`.

| Method | Path suffix            | Meaning                                             |
| ------ | ---------------------- | --------------------------------------------------- |
| GET    | `/`                    | List plans for a session                            |
| POST   | `/`                    | Preview and persist a plan only                     |
| POST   | `/:planId/acknowledge` | Record explicit fingerprint-matched acknowledgement |
| POST   | `/:planId/revoke`      | Revoke a plan                                       |

Acknowledgement example body:

```json
{
  "fingerprint": "sha256:<64 lowercase hex characters>",
  "confirmation": "I_APPROVE_THIS_PLAN_ONLY"
}
```

The proxy validates UUID path segments and same-origin JSON writes. No arbitrary filesystem path, Git command, branch name or Docker mount parameters are accepted from the browser. Invalid or corrupted storage files cause an error without automatic replacement.

## Scope and next PR

PR #9 modifies only the separate `gym-dev-hub` repository. It does not touch `gym-platform`, other local repositories, or GitHub write APIs.

PR #10 adds an [operator-secret-gated, one-time metadata-only worktree creation](safe-worktree-creation.md) stage. It revalidates paths and commit SHA before running a fixed Git command, but it does **not** checkout files or give Codex any new permissions. Full authentication, safe checkout and Docker mounts remain future PRs.
