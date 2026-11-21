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

## Launch #107 — trusted local Docker endpoint preflight

The operator now fails closed **before starting API/Web** when Docker's
effective context is not `unix:///var/run/docker.sock`, when
`DOCKER_HOST` points elsewhere, a custom `DOCKER_CONTEXT` or TLS credentials
are configured, or the socket path is not an actual Unix socket with no
world-access bits. A successful `docker info` alone was previously
insufficient: it can succeed against a **remote** Docker daemon.

Use the existing non-root launch from the trusted Linux Mint checkout:

```bash
cd ~/Projects/gym-dev-hub
sg docker -c 'pnpm dev:operator'
```

Do not work around a rejected context with `sudo`, `chmod 666`, an SSH/TCP
Docker daemon or a new bind address. Review the active Docker context and
local socket permissions outside of the Hub first. The default local
daemon must be accessible to the **operator process**, not merely the
interactive shell.

This is a **startup safety check**, not an executed isolated Docker
FORMAT/WEB_TEST/TYPECHECK audit or an end-to-end proof. #107 stays open
until the actual fixed non-networked recipes produce durable
`passed` receipts without a Nest API restart, with interrupted attempts
still recorded as `interrupted`. #79 root-cause watch investigation is
independent; the stable compiled API intentionally disables watch.

## Optional real Docker receipt diagnostics — Launch #107

The [isolated real Docker smoke](launch-fixed-docker-smoke.md) provides an
**explicitly operator-run** fixture for pinned WEB_FORMAT, WEB_TYPECHECK and
WEB_TEST execution, plus test-only durable journal projection. It does not
exercise or mark production grants, does not modify the primary checkout,
and is not evidence of end-to-end authorized HTTP workflow acceptance.
The preflight now rejects a stale pinned pnpm store (wrong source lockfile)
**before starting Docker**, and a failed isolated recipe can report only a
fixed allowlisted stage identifier, never raw test stderr or secrets.

## Production private pnpm store staging — #107

The operator's provisioned pnpm store remains **private** (directory mode
`0700`, file mode `0600`). The fixed Docker worker deliberately runs as
UID 65534 and cannot directly read those private files. The authorized
Docker execution now uses the same bounded store staging helper as the
explicit manual smoke:

- Require Linux non-root host, canonical store path with no symlink parents,
  matching manifest key and lockfile; read the manifest with `O_NOFOLLOW`.
- Stream-copy only verified pnpm store files into a new temporary `/tmp`
  directory, skipping pnpm's `v11/projects` host bookkeeping. Enforce
  80,000-file / 1.6-GiB bounds and verify a deterministic SHA-256 digest,
  file count and total bytes against the owner-provisioned manifest before
  making the stage readable by Docker UID 65534.
- Keep the original private store unchanged; stage files are read-only to
  other users, and the fixed Docker worker mounts the temporary store
  **read-only** with no network, no host project path or mutable worktree.
- Revalidate operator permission and exact one-file source after staging.
  Remove the newly created stage after container completion, even on failures.
  Cleanup failure is a rejected / unknown result, **never** `passed`.
  Never replay consumed grants or automatically rewrite `.env`.

Because the temporary mirror contains **public dependencies from the
public Gym Dev Hub lockfile**, do not use this workflow for secret/private
packages or publicly expose the host. A hard process crash may leave a
newly created, public-only temp mirror requiring **manual inspection**;
do not automatically delete unrelated `/tmp` paths. A temporary test-only
receipt is distinct from the production authorized audit. #107 remains
open until a real owner-authorized HTTP run and interrupted restart
have been independently verified.

## Launch #107 — real Nest HTTP one-time grant and persisted audit regression

`apps/api/test/worktree-patch-checks-http.e2e.spec.ts` boots the real
`WorktreePlanController` on ephemeral `127.0.0.1` with the **real**
`WorktreePatchChecksService` and file-backed, fsynced audit in a new private
test-only directory. The test exercises the real HTTP POST routes
`patch-check-authorize`, `patch-check-execute`, `patch-check-cancel` and
`patch-check-history`, with fixture plan/review/preflight data.

It verifies wrong operator secret rejection, explicit one-time grant and
token-replay denial, actual Nest response statuses, authorized success history,
redaction of secrets/token/file path, terminal Docker failure mapping to HTTP
503 and durable `failed`, cancel-requested → canceled audit ordering, and
`interrupted` projection after restarting the **test HTTP application**
with the same audit directory but a new in-memory grant map. No Docker
commands are reissued by history or during restart.

**Verification boundaries:** Docker execution, production Git review, and
source/store stages are mocked _only in this HTTP regression test_, never
replaced in the running operator. The separate, opt-in
[real Docker smoke](launch-fixed-docker-smoke.md) exercises the pinned
non-networked, non-root FORMAT/TYPECHECK/TEST runner and public-only
verified store mirror using a **test-only** journal. Passing both tests is
stronger layered evidence, but **not** an actual owner-authorized production
HTTP → Docker → audit run. Simulated interruption followed by a fresh Nest
instance is **not** proof of a real SIGKILL and operator restart. Keep #107
open until those specific live checks pass, with no production audit/secret
mutation by these tests.

## Launch #107 — manual integrated real HTTP → Docker → audit probe

The optional Vitest scenario in
`apps/api/test/worktree-patch-checks-live-http-docker.e2e.spec.ts` is **skipped
by default**, including in CI and `pnpm check`. It runs only when the operator
sets the **exact** `DEV_HUB_LIVE_HTTP_DOCKER_PROBE=I_APPROVE_ISOLATED_REAL_HTTP_DOCKER_PROBE`
flag. It requires non-root Linux, a pinned Docker image and a verified
offline pnpm store matching the current committed source lockfile.

From a **clean, disposable worktree**, not the live Hub checkout, use the
owner-managed trusted env file solely to load the pinned image setting.
Do not source the env file as shell code; pass a matching **newly provisioned
store absolute path** as `DEV_HUB_PATCH_CHECK_PNPM_STORE` to this one command.
For example, with the actual absolute values substituted locally:

```sh
sg docker -c 'cd /path/to/clean/gym-dev-hub/apps/api && DEV_HUB_LIVE_HTTP_DOCKER_PROBE=I_APPROVE_ISOLATED_REAL_HTTP_DOCKER_PROBE DEV_HUB_PATCH_CHECK_PNPM_STORE=/path/to/verified/pnpm-store node --env-file=/path/to/owner-private/apps/api/.env node_modules/vitest/vitest.mjs run test/worktree-patch-checks-live-http-docker.e2e.spec.ts'
```

It creates an **ephemeral Nest server bound only to 127.0.0.1**, and
a **new isolated real Git repository and linked worktree** created solely
from the exact published tracked source. It uses the real
`WorktreePlanController`, `WorktreeIntegrityService`,
`WorktreePatchPreflightService`, `WorktreePatchApplyService`,
`WorktreePatchReviewService`, one-time Docker-check grants, private
fsynced apply/check audits, verified private-store staging, and fixed
non-networked, non-root Docker runner.

The test submits an explicit one-file patch proposal, approves and
**atomically applies** it with the actual production service, verifies
the real `HEAD` diff and every other tracked Git blob, and rejects
an unexpected second-file change before continuing. It then authorizes
and executes `WEB_FORMAT` via real HTTP, rejects grant replay, checks
both isolated audit journals for redaction and durability, and restarts
the fixture Nest app to prove the passed history remains.

**Important boundary:** the **plan-discovery metadata**, the initial
worktree inspection summary and the Docker-boundary preflight are
controlled **test fixtures**, not a real owner-selected live plan.
The source is a separate Git commit from a fresh test-only repository,
not the original GitHub worktree branch; the edit is a harmless fixture
comment, not an approved business change. Fresh independent random
secrets are used only in the isolated process. No production `.env`
operator secret, grant map, checked-out source or audit journal is
modified. This is a **real Git review and real HTTP→Docker→audit fixture**,
but **not a production owner-approved workflow**.

The restart is a fresh test HTTP application, not a SIGKILL of the
running API. A hard process crash during staging may leave public-only
temporary snapshots under `/tmp` for owner inspection; do not
automatically remove unrelated directories. Keep #107 open until the
real live operator's authorized post-apply audit and controlled in-flight
API kill/restart are verified.

## Launch #107 — isolated real SIGKILL / HTTP audit recovery (manual)

`scripts/launch-sigkill-recovery-smoke.mjs` is an opt-in Linux-only
_destructive test of its own disposable child process_, **never** the
production Hub API, Web HMR or any user-owned Docker container. It is not
invoked by CI or `pnpm check`. The normal test suite covers only CLI
guardrails and strict Docker container ownership checks.

With a trusted owner-managed private env containing the pinned **public
Gym Dev Hub** runner image, and a verified offline public-only store for
the exact current `pnpm-lock.yaml`, run from a clean isolated Hub worktree:

```sh
pnpm --filter @gym-dev-hub/api build
sg docker -c 'cd /path/to/isolated/gym-dev-hub && DEV_HUB_PATCH_CHECK_PNPM_STORE=/path/to/verified/private-pnpm-store node --env-file=/path/to/owner-private/apps/api/.env scripts/launch-sigkill-recovery-smoke.mjs --confirm-isolated-sigkill-recovery'
```

The probe refuses root, remote/TLS Docker, a nonlocal Docker socket,
existing fixed-check containers, missing image/store or absent explicit
confirmation. It archives **only a specific committed Git tree** into a
fresh `/tmp/gym-dev-hub-sigkill-*` fixture (no dirty working files or
`.env`), creates independent random test-only operator credentials and
a private durable journal, then starts an **isolated child Node/Nest HTTP
server on 127.0.0.1**, with the actual `WorktreePatchChecksService`.
The reviewed plan and Docker boundary preflight are **controlled
fixtures**; this test does not repeat the real patch review in #125.

After the child issues a genuine single-use HTTP grant and fsyncs
`issued → attempted`, the parent observes an actual **running**
non-root, network-disabled `WEB_TEST` Docker container. It verifies
the container's pinned image, immutable read-only mounts, exact
disposable source path, store-stage key and parent-owned identity
**before sending SIGKILL to the exact child PID it spawned**. A **new
child process and new Nest app** then queries the same on-disk audit
using the actual history endpoint and confirms `interrupted` and
HTTP 409 for replay, without any fabricated `passed` or `rejected`
record. The parent removes **only the container it independently
verified belongs to its fixture**, and only the temporary source/store
folders proven to belong to this run. Foreign/ambiguous containers
or an unproven stage cause a fail-closed result and manual inspection.

Only a successful complete cleanup returns a success receipt. A crash
of the **parent** can leave a public-only temporary store or Docker
container requiring manual inspection; never blindly prune Docker
containers or all `/tmp/gym-dev-hub-*` folders. Live production audit,
secrets, running API/Web services and Gym Platform are never touched.

This verifies an actual in-flight disposable-process **SIGKILL →
real Docker interruption → cold HTTP restart → durable
`interrupted`**. It is **not** a live owner-approved production
plan, production grant or production audit acceptance. Keep #107
open until these separate operational prerequisites are verified.

## Launch #107 — read-only live operator readiness gate

Before issuing **any real production** patch/check grant, run
`scripts/launch-live-operator-readiness.mjs` in an isolated clean checkout
of the **exact reviewed and owner-merged main commit**. It performs
**read-only** checks, without starting/stopping Hub, inspecting raw
audit records, writing state, creating an auth grant or running Docker
recipes. It only reads local repository, image, manifest, socket and
filesystem **metadata**, and verifies the full content-addressed
**public package store** against its existing SHA-256 manifest.

With a trusted owner-managed private env file (never `source` it as
shell commands), use the pinned full main SHA and the actual operator's
checkout directory:

```sh
sg docker -c 'cd /path/to/clean/latest/gym-dev-hub && node --env-file=/path/to/owner/apps/api/.env scripts/launch-live-operator-readiness.mjs --expected-main=REPLACE_WITH_40_CHAR_MAIN_SHA --operator-checkout=/path/to/actual/live/gym-dev-hub'
```

Replace the SHA with the **verified, actual owner-merged main HEAD**;
it is an external pin, not fetched or assumed by this command. Use the
original main checkout, **not** the temporary PR worktree, for
`--operator-checkout`. This does not attempt a Git fast-forward, reset,
restart or dirty-file cleanup.

Checks include:

- Non-root Linux Node 24+, opt-in gates and independent strong
  operator secrets (only their **validity**, never their contents).
- The examined source and **actual operator checkout** both at the
  externally pinned main SHA, with trusted Git origin.
- **Explicit**, already existing, canonical, owner-private audit
  directories for patch apply and Docker checks. Default cwd-derived
  audit folders do not count as production readiness.
- Configured offline store key tied to the exact committed
  `pnpm-lock.yaml`, a private owner-owned manifest and full store digest,
  with strict bounded file inventory. Never chmod the original store.
- A genuinely accessible local private Docker Unix socket and the
  exact pinned, non-root, Linux network-disabled recipe runner image
  metadata. No Docker container is started.

Returns only fixed-code JSON reasons/checks; exits **2** when blocked,
**0** only for `prerequisites-checked-only`. Do **not** interpret
exit 0 as an owner authorization, a verified running API image, a
reviewed business patch, or proof of production audit receipts. In
particular, **a currently running API can still use an earlier compiled
build even if its checkout HEAD was updated**. Real runtime provenance,
explicit owner review of the selected worktree, grants, actual Docker
FORMAT/TEST/TYPECHECK, audited results, and controlled production
restart need separate acceptance. Never merge, restart, edit
`.env`, or mutate the primary dirty checkout based on this report.

For the current Linux Mint installation, the previously observed
runtime checkout was behind `main`, the configured private store had
an outdated lockfile key, and audit directories were not explicitly
configured. The gate reports those discrepancies rather than silently
correcting them. After the owner separately reconciles source and
private configuration, rerun preflight before planning a live grant.

## Launch #107 — owner-confirmed private backup **before** Git fast-forward

After `launch-source-reconcile.mjs` has verified an externally pinned
main commit is a genuine fast-forward with **no dirty-file path
collisions**, you can preserve the two known local tracked edits
(`turbo.json` and `apps/web/next-env.d.ts`) without changing the
original checkout. Use this bounded, optional copy-only command in a
clean Hub worktree that contains the new script:

```sh
node scripts/launch-source-owner-backup.mjs \
  --confirm-copy-only \
  --expected-main=REPLACE_WITH_VERIFIED_40_CHAR_MAIN_SHA \
  --operator-checkout=/absolute/path/to/actual/primary/gym-dev-hub \
  --backup-parent=/absolute/path/to/already-existing/private-owner-directory
```

The **backup parent must already exist**, be a real canonical directory
outside the primary repository, owned by the invoking non-root Linux
user and private to that user (no group/other access). The script
reuses `inspectSource` and **refuses** staged/renamed/conflicted Git,
an unknown origin, untrusted or absent main commit, diverged branches,
dirty/upstream path collisions, symlinks, unsafe private state, and
any tracked dirty path other than the two explicitly reviewed files.

The script only reads the two source files via no-follow handles and
compares inode, size and timestamps before/after reading. It writes
**new, exclusive 0600 copies**, plus a 0600 hash/size manifest, into
its own freshly created 0700 `source-owner-backup-*` directory;
fsyncs the files and directory; rereads both copies, checks their
SHA-256, and revalidates original Git HEAD and source byte content.
The output contains only the backup location, verified count and Git
commit identifiers (never raw file contents or operator credentials).
Existing backups are never overwritten, and failures leave any
partial snapshot for explicit owner inspection rather than deleting
potential recovery data.

**Important scope:** `apps/api/.env`, `apps/api/.local`, the many
registered linked worktrees and `.worktrees/` are **left completely
untouched**, and **are not backed up** by this narrow source-file
backup. Back them up separately with an owner-chosen secure method
before changing their state, if needed. Nothing calls `git pull`,
`checkout`, `stash`, `reset`, `merge`, `worktree prune`,
`chmod` on source files, or any Docker command; no production audit
is read or changed and no API/Web process is restarted.

**A verified backup is not permission to fast-forward or restart the
operator.** Review the manifest and original local edits; decide with
the owner how to handle the dirty files and linked worktrees. Only
after explicit separate approval and a new reconciliation preflight
should a controlled, non-destructive Git fast-forward be attempted.
Then verify the running compiled API build and repair the pinned
dependency store/explicit private audit directories under a separate
manual cutover before actual production HTTP→Docker acceptance.
