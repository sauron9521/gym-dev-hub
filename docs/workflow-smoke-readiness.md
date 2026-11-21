# PR #71 — read-only full workflow smoke preflight

Gym Dev Hub now has deliberately separate, opt-in actions for a single
approved source file: worktree → hydration → scoped read → patch
preflight/apply → Git review → fixed Docker checks → reviewed commit
candidate → local Git commit → published GitHub task branch → Draft PR →
read-only GitHub CI. The entire real operator/browser flow has **not**
been tested end-to-end with live credentials.

This PR does **not** execute those operations. It provides a read-only
preflight report to distinguish missing prerequisites from a real test
result. No secrets or token _values_ are returned or logged.

## Where to see it

Open the local Workspace at `http://127.0.0.1:3100/workspace` and
look for **Перевірка готовності до тестового запуску**. Click
**Перевірити ще раз** to recheck. The local Web app forwards a fixed
**GET** path to the API:

```text
GET /workspace/sessions/workflow-readiness
GET /api/workspace/workflow-readiness
```

Only environment **key names**, step status, short Git SHA and general
notes are shown. A key is marked missing if its opt-in is not the literal
`true`, its independent secret is not at least 32 bytes or exceeds
256 bytes, or its GitHub token is not a valid-looking 32–1024-character
non-whitespace value. Explicit Git author name and email are validated.
The checker never reads token scopes or contacts GitHub using a
**write** credential. GitHub `main` is checked with an existing public
read-only GitHub request; the local `HEAD` is checked with the
existing restricted read-only Git helper. It does **not** call
`git fetch`, `pull`, `checkout`, `reset` or a Git write.

The local source must resolve to the exact authorized
`sauron9521/gym-dev-hub` repository under the trusted repos root.
The GitHub and local SHA must **match** before the preconditions are
reported as fully configured. If GitHub is unavailable, the remote
state is **unknown**, not passed.

## What each stage means

The 11 steps are: source SHA, worktree creation, hydration, scoped
read/mount, patch apply and Git review, fixed Docker checks, commit
candidate, local commit, GitHub task branch publication, Draft PR, and
CI readiness. Missing key names are printed for each _configuration_
gate. The report also returns explicit `false` for:

- `githubPermissionsVerified`: presence of a token is not proof of
  `Contents:write`, `Pull requests:write` or `Contents:read` rights
- `dockerExecutionVerified`: a flag does not prove a safe container can
  execute or that the fixed test recipes pass
- `endToEndVerified`: a successful configuration check is **never**
  an end-to-end acceptance test
- `writesPerformed` and `mutatingCommandsExecuted`: this preflight
  only reads local and remote Git metadata

The Hub is localhost-only and is **not hardened for untrusted
multi-user exposure**. Even though no secrets are returned, the API
does reveal capability configuration state; do not bind it publicly.

## Actual manual acceptance after preflight

1. Save/back up any pre-existing local work, including
   `turbo.json` and `apps/web/next-env.d.ts`, before synchronizing
   the **primary local checkout** with the GitHub `main`.
   Do not reset or overwrite dirty files. Restart API and Web from
   the updated source.
2. Independently configure only the required feature opt-ins and
   operator secrets in **ignored local** `apps/api/.env`.
   Never commit tokens or paste them into chats. Use separate
   fine-grained tokens limited to this repository:
   `Contents:write` for publishing, and
   `Pull requests:write` plus `Contents:read` for Draft PR.
   Do not simply copy the dashboard's `GITHUB_TOKEN`.
3. Run the preflight again. For each passing configuration stage,
   complete its **existing explicit human authorization** in a
   disposable worktree. Verify an actual Docker isolation run and a
   successful fixed recipe, plus a reviewed one-file diff.
4. Create one local task commit, confirm its SHA, publish **only the
   new disposable** `devhub/task-*` branch, authorize one **Draft PR**,
   check that the created PR targets `main` and CI is actually running.
   The **repository owner** performs final review and merge separately.
   Never use a fake/missing check as an all-green signal.
5. After an ambiguous GitHub response, stop. Inspect GitHub and the
   per-plan audit/lock **manually**. Do not retry a consumed grant or
   delete recovery locks without investigating.

Automated tests in this PR use only mocked read-only GitHub/local-Git
results, verify missing credentials and source drift fail closed and
assert no secrets are ever included in the returned report. They do
not perform a live write or configure any new permission.

**Next slice after a real disposable E2E acceptance test:** durable
operator workflow checkpointing and refresh/resume, preserving
one-time grants' security (never persisting bearer tokens or secrets).
