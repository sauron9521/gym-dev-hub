# Gym Dev Hub

AI-assisted development orchestration workspace. This is an **independent public repository**; it does not require modifications to `gym-platform`.

## Prerequisites

- Node.js 24+
- pnpm 12.18.0

## Local development

```bash
pnpm install --frozen-lockfile
pnpm dev
```

- Dashboard: http://127.0.0.1:3100
- API: http://127.0.0.1:3101/health/live
- GitHub read-only data: http://127.0.0.1:3101/github/dashboard

The dashboard reads `sauron9521/gym-dev-hub` and `sauron9521/gym-platform` from the GitHub public API by default. For additional repository access and rate limits, copy `apps/api/.env.example` to `apps/api/.env` and configure an optional read-only GitHub token. Never commit tokens.

See [GitHub Dashboard and PR Checks setup](docs/github-dashboard.md) for the per-PR `/pr/[number]` verification page, capabilities, and limitations.

## Verification

```bash
pnpm check
```

The monorepo includes Next.js, NestJS, shared TypeScript/contract packages, and GitHub Actions CI. AI sessions, write operations, persistent storage, and workers are **not** part of the current read-only dashboard.

## Safety and governance

Agents may eventually create branches and PRs but **may not merge** them; the repository owner reviews and merges. Keep credentials local in ignored environment files or a secure secret store. CI has read-only GitHub token permissions and no user credentials.

See [architecture](docs/architecture.md) and [roadmap](docs/roadmap.md).
