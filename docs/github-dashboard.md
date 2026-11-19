# Read-only GitHub Dashboard and PR Checks

This tool uses GitHub REST to inspect allowlisted repositories without changing them. No changes are needed inside `gym-platform`.

## Configuration

The default allowlist is `sauron9521/gym-dev-hub,sauron9521/gym-platform`. Override it with `GITHUB_REPOSITORIES` in `apps/api/.env` (copy `apps/api/.env.example`).

Public GitHub requests work without a token but are rate-limited. A fine-grained read-only `GITHUB_TOKEN` can be added to `apps/api/.env`. For PR check details, grant **Pull requests: read**, **Checks: read**, **Commit statuses: read** and **Contents: read** as applicable. Branch protection visibility may require additional repository-administration read permission; if unavailable, Dev Hub will report **unknown**, never an automatic green readiness verdict.

Web communicates server-side with NestJS at `http://127.0.0.1:3101` unless `DEV_HUB_API_URL` is set in `apps/web/.env.local`. Do not expose API credentials via `NEXT_PUBLIC_`.

## Local launch

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:3100` and select a repository.

## API

```http
GET /github/dashboard?repository=sauron9521/gym-platform
GET /github/readiness?repository=sauron9521/gym-platform&number=123
```

The dashboard loads 15 open PRs, up to 15 open Issues (excluding PRs), up to 30 open Milestones, and the 15 most recent workflow runs. Its inline PR CI badges are **approximate** snapshots from recent workflow runs; click **Перевірити** for a more complete per-PR check.

The readiness endpoint requests:

- Actual PR `head.sha`, `base.ref`, draft and mergeability data;
- GitHub Check Runs for the PR head SHA, newest attempt for each check/app;
- GitHub legacy commit status contexts for the same SHA;
- Classic branch protection required status checks, including required GitHub App IDs.

The endpoint distinguishes checks still running, failures, missing required contexts, and source failures. A failed/unknown API section is **not zero checks**. Requests are cached in memory for 20 seconds and concurrent requests for the same PR are deduplicated. Max 100 check-runs and status records per request; a truncated dataset is treated as incomplete.

The readiness verdict is **ready for manual review**, **blocked**, **pending**, or **unknown**. It is **not** an authoritative permission to merge: GitHub Rulesets, review approvals, up-to-date branch requirements and repository policies may impose further gates. The owner always reviews the actual GitHub PR and merges manually.

## Security boundaries

- Web and API bind to loopback by default. The MVP has no user authentication, so do not expose it to external networks.
- Both endpoints only read repositories in the local allowlist, and PR number must be a positive safe integer.
- No GitHub write, merge, branch mutation, or automatic PR creation functionality in this milestone.
- Token stays in NestJS; never include credentials or private environment files in Git.
