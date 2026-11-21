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

## Non-root Docker check source staging (E2E follow-up)

The first real local E2E run after PR #72 reached the fixed Docker
`WEB_TYPECHECK` recipe, but its runner rejected staging. Hydration correctly
created original worktree files as `0600`; the intentionally non-root Docker
UID `65534` cannot read those files from a raw read-only worktree mount.

The follow-up fix uses a **bounded, disposable sibling source snapshot**
while a single previously approved fixed check runs. Its copied directories
are mode `0755` and copied regular files `0644` on POSIX, so the isolated
runner can read and copy them. The original hydrated worktree keeps its
`0600` files and is never chmod'd. All source files are revalidated after
staging, Docker remains non-root / networkless with read-only bind mounts,
and the stage is removed using only known created files/directories in a
`finally` block. Failed cleanup fails closed. This temporary snapshot
contains only the public, tracked Gym Dev Hub tree (not `.git`), under the
same 5,000-file / 100 MiB bounds as the fixed runner. It is not suitable
for sensitive or untrusted private repository content.

Each failed one-time check remains **rejected** in the audit; do not replay
its grant. Start a fresh authorization after the code change is deployed.
Successful source staging alone is not proof of pnpm store hydration,
TypeScript checks, tests, or GitHub PR readiness.

## Reproducible bounded pnpm store for fixed Docker checks (Issue #74)

The host's shared pnpm v11 cache can be much larger than the Docker
runner's 80,000-file / 1.6 GiB safety limit. Do not mount the global
cache, prune it, or raise the runner limits. Run this operator-only,
trusted-host preparation from the **updated Gym Dev Hub checkout**:

```bash
pnpm provision:patch-check-store
pnpm provision:patch-check-store:verify
```

The command requires Linux x64, Node 24 and pnpm **12.18.0**. It creates a
metadata-only temporary workspace with the locked API/Web package manifests
and fetches dependencies into an **isolated ignored** pnpm store. The sole
network-enabled operation is a host-side `pnpm fetch` against the fixed npm
registry, with a frozen lockfile, no pnpmfile and no package scripts. A full
`pnpm install --offline --frozen-lockfile --ignore-scripts` validates the
closure and integrity before the store is published. The tool refuses an
unsupported file type, symlink, incomplete index, excessive size/count or
changed lockfile and records a deterministic digest of every accepted file.
It neither reads the main pnpm store nor runs package lifecycle scripts.

The command prints the final absolute `path`. In the **ignored**
`apps/api/.env`, set:

```dotenv
DEV_HUB_PATCH_CHECK_PNPM_STORE=/absolute/path/printed/by/provisioner
```

Restart the local API and verify the store before executing any new
single-use `WEB_TYPECHECK` or `WEB_TEST` grant. The runtime still mounts
this store read-only, stages it to private Docker tmpfs, has networking
disabled and retains the unchanged 80,000-file / 1.6 GiB bounds. The
manifest stays outside the mounted store. If the lockfile changes,
provision a new path. The host-side dependency fetch is **not** a task
that agents or the API can invoke. This provisioner currently supports
Linux x64; Windows performance/transport is tracked separately in #59.

The E2E on 2026-11-21 verified `WEB_TYPECHECK` using an isolated 25,364-file
store; `WEB_TEST` reached `FIXED_CHECK` and returned nonzero. That test
runner failure is a separate issue, not proof of a complete workflow.

## Alpine/musl native optional dependency closure (Issue #76)

`WEB_TYPECHECK` passed with the original v1 store, but `WEB_TEST` could not
start Vitest in the Alpine Docker runner: Rollup required the locked native
`@rollup/rollup-linux-x64-musl` module, while the glibc-only host fetch did
not include it. This was confirmed with a temporary **credential-free,
networkless** diagnostic container.

The v2 provisioner now adds only to its temporary metadata mirror:

```yaml
supportedArchitectures:
  - linux-x64
  - linux-x64-musl
```

Both native variants come from the same frozen `pnpm-lock.yaml` and are
verified through pnpm's offline frozen install. This does **not** edit the
actual project's `pnpm-workspace.yaml` or the original source tree. The
new v2 store key prevents silently reusing a previously verified glibc-only
store. After merging the fix, run `pnpm provision:patch-check-store` and
`pnpm provision:patch-check-store:verify` again, update the ignored
`DEV_HUB_PATCH_CHECK_PNPM_STORE` path, and restart the API. Do not replay
consumed one-time Docker grants.

## Mandatory Prettier gate before audited Git commit (Issue #81)

During the first real operator E2E on Draft PR #80, `WEB_TYPECHECK` and
`WEB_TEST` both passed but GitHub CI rejected a valid TSX text change at
`Formatting`: it did not respect the repository's root `.prettierrc.json`
(`printWidth: 100`). The successful corrected E2E in PR #82 confirms that
formatting must be enforced **before** the one-time Git commit grant.

A new **fixed `API_FORMAT` / `WEB_FORMAT` recipe** checks exactly the
approved SHA-pinned source file using the installed lockfile-pinned
Prettier binary and an explicit root `.prettierrc.json`. It executes inside
the same non-root, networkless, read-only-source Docker runner as the
existing fixed checks. The recipe is never an arbitrary command. Its
receipt has both `testsExecuted=false` and `typecheckExecuted=false`, is
validated against the approved source SHA, and is kept in the same append-
only, single-use-grant audit as the other Docker checks. A non-zero
Prettier result is not a successful receipt.

**Commit candidate preview/acknowledgement and commit write** now require
a matching `*_FORMAT: passed` audit receipt **and** at least one matching
TypeScript or Vitest pass. Missing or failed format is a hard 409, not a
warning. Previously created unmerged candidates without a matching
format receipt do not acquire new Git write authorization by default.

The Docker recipe changes the existing immutable runner script; after
merging, rebuild the fixed runner from the **approved updated source** and
update the trusted, ignored `DEV_HUB_PATCH_CHECK_IMAGE_ID` to its verified
new `sha256:...` image ID **before** authorizing fresh formatting checks.
Do not disable the image hash pin, change `.env` secrets or reuse already
consumed grants. A new isolated recipe `API_FORMAT` / `WEB_FORMAT` may
require re-provisioning the pinned store only when the lockfile changes;
this PR does not change the lockfile.

## Investigating unexpected NestJS `--watch` restarts (Issue #79)

Normal development (`pnpm --filter @gym-dev-hub/api dev`) uses the NestJS
TypeScript watcher, which intentionally restarts the API child when the
compiler sees a source-file change. In the first long-running Docker E2E,
that restart disconnected HTTP, and the durable receipt was correctly
recorded as `interrupted`, **not** `passed`. A separate live Nest CLI
reproduction verified that creating and deleting a full 303-file snapshot
under `apps/api/.local/worktrees` **did not** trigger a restart; modifying
`apps/api/src/main.ts` did. Blanket excluding `.local` would therefore
not be an evidence-backed fix.

For targeted **opt-in** diagnostics (never enabled on the primary API), run:

```bash
pnpm diagnose:nest-watch             # separate 127.0.0.1:3102 API
# or: pnpm diagnose:nest-watch 3103
```

The launcher creates a new local ignored `apps/api/.local/nest-watch-diagnostics/`
JSONL file (mode `0600`) and starts the same Nest CLI watch compiler under
Node's diagnostic-only `fs.watch`/`fs.watchFile` preload. Each file-change
notification records timestamp, process PID, event type and a sanitized
repository-relative path. Private `.local` and other sensitive/unrelated
paths are redacted or SHA-256-prefixed; **no file content, keys, environment
variables or command arguments** are written. High-volume dependency/cache
notifications are sampled, while owned source-file changes are retained. The
trace is capped at 256 KiB and closed automatically when Nest exits. The launcher also writes a fixed `compiler-rebuild` marker with the Nest CLI
process ID and timestamp each time it sees TypeScript's `File change detected. Starting incremental compilation...`
watch notice. It streams the original terminal output to the operator but
**never writes its raw output** to the JSONL log. Compare the marker with
preceding `fs.watch` / `fs.watchFile` events. A nearby event is a suspect,
not proof of causation; reproduce it independently before changing watch
configuration. This marker is collected only in opt-in diagnostics, never
in the stable operator API. The diagnostic Nest CLI and its spawned API live
in a dedicated process group, so stopping the opt-in launcher also stops its
API child and releases the diagnostic port. Add or remove _only throwaway files_ in a dedicated
worktree to validate a suspected watcher trigger, and never touch the primary
Hub service or reuse consumed one-time grants.

Until a specific offending watched path is reproducible and fixed, run
long-running approved Docker checks with a stable built API:

```bash
pnpm --filter @gym-dev-hub/contracts build
pnpm --filter @gym-dev-hub/api build
sg docker -c 'cd /path/to/gym-dev-hub && pnpm --filter @gym-dev-hub/api start'
# In another terminal: pnpm --filter @gym-dev-hub/web dev
```

This preserves existing audit and interruption semantics. No changes are
made to tracked NestJS watch configuration, CI or regular `pnpm dev`.

## Stable local operator workflow for audited Docker checks (Issue #79 mitigation)

`pnpm dev` remains the full hot-reload development workflow. For long-running
audited checks on Linux, use the stable API with Next.js Web HMR:

```bash
cd ~/Projects/gym-dev-hub
sg docker -c 'pnpm dev:operator'
```

The trusted-host command checks Linux/Node 24, pnpm 12.18.0, the current
process's Docker socket access, and free localhost ports **3101 (API)** and
**3100 (Web)**. It builds the contracts and API once and starts the compiled
API with `node apps/api/dist/main.js` **without Nest `--watch`**, while
starting Next.js `dev` with HMR and a localhost-only API proxy. Shutdown
signals terminate only the two spawned process groups; unexpected child exits
terminate the whole operator session with a nonzero status. It does not mutate
Git, `.env`, Docker images, authorizations or audit receipts. It refuses to
start if ports are occupied; stop previous servers yourself instead of
letting this command terminate unrelated processes.

For an independent test session, alternate localhost ports are supported:

```bash
DEV_HUB_OPERATOR_API_PORT=3211 DEV_HUB_OPERATOR_WEB_PORT=3210 \
  sg docker -c 'pnpm dev:operator'
```

This should make the API reachable at `http://127.0.0.1:3211/health/live` and
Web at `http://127.0.0.1:3210/workspace`; the Web proxy points at 3211.
This **prevents watch-triggered API restarts while operator checks run** by
not enabling API watch, but does **not** identify the initial triggering file.
Keep #79 open for root-cause investigation via the diagnostic PR #84 and
keep the existing fail-closed `interrupted` audit semantics.
