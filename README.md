# Gym Dev Hub

AI-assisted development orchestration workspace. This is an **independent public repository**; it does not require any modifications to `gym-platform`.

## Prerequisites

- Node.js 24+
- pnpm 12.18.0 (via Corepack or standalone)

## Local development

```bash
pnpm install --frozen-lockfile
pnpm dev
```

- Web: http://127.0.0.1:3100
- API: http://127.0.0.1:3101/health/live

## Verification

```bash
pnpm check
```

The initial bootstrap includes two apps (Next.js and NestJS), a shared API contract and TypeScript settings, and GitHub Actions CI. GitHub App integration, AI agents, persistent storage and workers will be introduced in separate small PRs.

## Safety and governance

Agents may create branches and PRs but **may not merge** them; the repository owner reviews and merges. Keep credentials local in ignored environment files or a secure secret store. CI runs with read-only GitHub token permissions and no user credentials.

See [architecture](docs/architecture.md) and [roadmap](docs/roadmap.md).
