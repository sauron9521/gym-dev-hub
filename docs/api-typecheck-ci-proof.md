# CI-only API_TYPECHECK: verified pinned Gym Platform source

The isolated runner now can **prove the exact TypeScript compiler recipe** of one immutable Gym Platform API snapshot in GitHub Actions. This is a prerequisite for, **not** the implementation of, one-use operator-controlled task execution from the Hub.

## Fixed reviewed inputs

- Gym Platform commit: `7104f723c4ee7b81e7b9b64e9c9483aea344ef7a`
- Tree: `2c140e1e740b3dd8cc7582db726f46b54b73b334`
- Git manifest SHA-256: `dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b`
- TypeScript `6.0.3`, Prisma CLI `7.10.1`, independently pinned Alpine-musl Prisma schema-engine.
- Fixed `@gym/api` script: `tsc --noEmit -p tsconfig.build.json`.

The workflow uses the pre-existing immutable Git export, independent manifest verification, pinned lockfile and SHA-512 checks, and a trusted network stage with lifecycle scripts disabled. At runtime the full dependency closure is rehydrated _offline_ into a disposable private `/workspace`.

The new `api-typecheck-ci.mjs` runs the existing fixed `prisma-native-preflight.mjs` in **the same disposable container**, checks its structured proof (source identity, offline dependency installation, generated Prisma Client, disabled scripts and no task execution), then invokes precisely:

```text
/usr/bin/node /workspace/project/node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
cwd: /workspace/project/apps/api
```

It validates TypeScript package identity/version, the original pinned API script mapping and `tsconfig.build.json`, never shells out to arbitrary project scripts or accepts caller-provided argv. TypeScript performs static analysis; this does **not** boot NestJS or connect to a database.

## Isolation and limits

GitHub Actions verifies the Docker configuration before starting the container: `--network=none`, read-only root, UID 65534, dropped capabilities, no new privileges, no Docker socket, 2 CPU, 5 GiB memory and 128 PIDs. The `/source`, `/manifest`, `/store` and `/engine` mounts are read-only. The disposable `/workspace`, `/results` and `/tmp` mounts are `noexec`.

The fixed Prisma preparation and TypeScript steps have bounded timeouts; stdout and stderr are capped at 64 KiB per process. Git-pinned source files are never writable. A successful CI run returns a small JSON receipt; a nonzero TypeScript exit or incomplete previous proof fails the job. Pure unit tests reject forged receipts, changed commands, enabled lifecycle hooks, unexpected network access and grant consumption.

## Explicit non-goals

- **No Hub HTTP execution route, Docker task runner action or operator grant consumption** is enabled here. Existing task grants continue to return `consumed-no-execution`.
- The source is still the fixed reviewed Git snapshot, not arbitrary newer branches or PRs.
- No Git writes to Gym Platform, code edits, auto-merge, database connections or secrets.
- A separate PR must bind an already-present one-time grant to a concrete local execution operation with fresh worktree verification, cancellation, bounded diagnostics, Docker lifecycle cleanup, and negative authorization tests.

This distinction is intentional: CI proving a bounded compiler recipe is not authorization to execute untrusted repository code on the user's computer.
