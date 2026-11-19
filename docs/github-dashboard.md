# Read-only GitHub Dashboard

PR #2 introduces a local, read-only GitHub data surface. Neither `gym-platform` nor other target repositories require changes.

## Configuration

The initial allowlist is `sauron9521/gym-dev-hub,sauron9521/gym-platform`. Override it with `GITHUB_REPOSITORIES` in `apps/api/.env` (copy from `apps/api/.env.example`).

The API calls GitHub's public REST API by default. Public unauthenticated requests have low rate limits. To increase limits or read private repositories later, configure a **fine-grained token with read-only permissions** in `apps/api/.env` as `GITHUB_TOKEN`. Never commit tokens. For private repositories, additional GitHub permissions may be required.

The Web server talks to NestJS at `http://127.0.0.1:3101` by default. Set server-side `DEV_HUB_API_URL` in `apps/web/.env.local` if needed. Do not expose it via `NEXT_PUBLIC_`.

## Local launch

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:3100`. Both apps must run for the dashboard to load.

## API

```http
GET /github/dashboard?repository=sauron9521/gym-dev-hub
```

Returns allowlisted repositories, selected repository details, up to 15 open PRs, up to 15 open Issues (excluding PRs), up to 30 open Milestones and the 15 most recent workflow runs. Data are fetched from GitHub on every page load; **there is no background polling** yet. The `unavailable` field distinguishes failed source requests from truly empty sections.

PR CI labels are a **best-effort approximation** derived from the most recent 50 workflow runs matching the PR head SHA. If no matching run is found, the UI labels CI as `unknown`, never `success`. **Do not treat this as a merge-ready decision**. A later PR will implement authoritative commit check-runs and branch protection gates.

## Security boundaries

- Backend and Web bind to loopback by default. This MVP has no authentication, so do not expose its API to public networks.
- Public dashboard requests are strictly limited to configured repositories.
- No GitHub POST/PATCH/DELETE endpoints or merge functionality.
- Token stays in the NestJS process. It is never sent to the browser and is ignored by Git.
