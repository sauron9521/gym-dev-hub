# Issue #106 — safe reconciliation of the primary Linux Hub checkout

This is a **trusted-local-operator runbook**, not an agent write permission. Before M0 launch, the primary checkout used by the running Web/API must match GitHub `main` without silently changing private files, dirty tracked files, worktrees, operator tokens or audit journals.

## Verified initial inventory — 2026-11-21

- Repo: `/home/sauron/Projects/gym-dev-hub`, branch `main`, local HEAD `957aafc0b42d41ffc6c5f90617a425ba6452fbec`.
- GitHub main at inspection: `afc830955c96c6f1fa435697f437c30f84a63662` (owner-merged #118); local HEAD is an ancestor, **33 commits behind**. Always check again; **do not hard-code this SHA** as live main.
- Dirty tracked files: `turbo.json` and `apps/web/next-env.d.ts`. Neither was changed upstream over this range; no overlapping Git paths in this particular inspection.
- Local untracked `.worktrees/` (~507 MiB), private `apps/api/.local/` (~2 GiB, includes **live linked task worktrees and journals**), and ignored `apps/api/.env` are present. Git advertises about **50 linked worktrees**; **never run** `git clean -fd`, `git worktree prune`, `git reset --hard`, or destructive migration/backup cleanup.
- Live Hub API and Web on loopback ports `3101` and `3100`; process inspection showed a running `sg docker -c 'pnpm dev:operator'` supervisor (Node API built once, Web HMR). A normal shell's `docker ps` reported socket permissions, **but that does not establish the supervisor's Docker access**. Do not start a second supervisor on occupied ports.
- The previous HTTP readiness report had `source=blocked` because local HEAD differed from GitHub, despite **10 of 11** configuration gates. `endToEndVerified=false`, `githubPermissionsVerified=false` and `dockerExecutionVerified=false`; do not reinterpret a green source gate as live workflow acceptance.

## Step 1 — non-mutating source preflight (safe to run now)

From a **reviewed copy of the newest Hub main** (e.g. a fresh isolated worktree; not the older primary scripts), supply a **real independently verified full GitHub main SHA**. Fetch if necessary: `git fetch --no-tags https://github.com/sauron9521/gym-dev-hub.git main` is a network read of refs/objects that does **not** change the checked-out branch; it does update `FETCH_HEAD`. It must not be confused with approval to update tracked files.

```sh
# Read GitHub's main SHA from trusted GitHub; validate the value and your repo.
MAIN_SHA="$(git -C /home/sauron/Projects/gym-dev-hub rev-parse FETCH_HEAD)"
node scripts/launch-source-reconcile.mjs \
  --root /home/sauron/Projects/gym-dev-hub \
  --expected-main-sha "$MAIN_SHA"
```

The script executes **local read-only Git inspection** (no network, no fetch, no shell interpolation, no git update). It validates exact Git origin, `main` branch, object type, ancestor ancestry, staged/merge conflicts, dirty tracked and untracked path overlap with the target, linked worktree count and private path presence. It prints metadata only; **never prints token/env values, reads private files, stores snapshots or mutates Git**.

- `preflight-passed`: there is a **candidate** for owner-reviewed fast-forward; it **does not** verify a backup, authorize a merge, restart the runtime or prove Docker access.
- `up-to-date`: local Git head matches the externally verified pinned SHA; **still** compare the running built API with that source.
- `blocked` / exit 2: stop, inspect read-only. No automatic stash/reset/retry. A stale/missing GitHub SHA, divergent ref, dirty collision, staged/unmerged index, unexpected symlink or untrusted origin fails closed.
- Re-run the preflight and independently check current GitHub main **immediately before** the real operation; never rely on a prior cached report.

## Step 2 — owner-controlled backup and verification (NOT done by preflight)

Do not take a supposed consistent backup of `apps/api/.local/` while the Hub may still be writing there. Arrange an owner-approved, graceful **stop** of the existing Hub supervisor first; do not blindly kill port occupants. Preserve app secrets with private filesystem permissions and **never paste tokens into chat, git, logs or issues**.

A sample workstation-local private snapshot **after services have stopped** (inspect target paths and available disk space first):

```sh
set -e
cd /home/sauron/Projects/gym-dev-hub
umask 077
install -d -m 700 "$HOME/.local/state/gym-dev-hub"
BACKUP="$(mktemp -d "$HOME/.local/state/gym-dev-hub/source-106-XXXXXXXX")"
install -d -m 700 "$BACKUP/tracked/apps/web"
cp -p -- turbo.json "$BACKUP/tracked/turbo.json"
cp -p -- apps/web/next-env.d.ts "$BACKUP/tracked/apps/web/next-env.d.ts"
cmp -- turbo.json "$BACKUP/tracked/turbo.json"
cmp -- apps/web/next-env.d.ts "$BACKUP/tracked/apps/web/next-env.d.ts"

# Backup private .env, linked worktrees, audit journals and in-progress tasks.
# Contains secrets: never upload or commit this backup.
install -d -m 700 "$BACKUP/private"
cp -p -- apps/api/.env "$BACKUP/private/api.env"
tar --create --file "$BACKUP/private/worktrees-and-local.tar" \
  -- .worktrees apps/api/.local
tar --list --file "$BACKUP/private/worktrees-and-local.tar" > /dev/null
sha256sum "$BACKUP/private/worktrees-and-local.tar" \
  > "$BACKUP/private/worktrees-and-local.sha256"
(cd "$BACKUP/private" && sha256sum -c worktrees-and-local.sha256 > /dev/null)
chmod -R go-rwx "$BACKUP"
```

If additional user-owned dirty paths appear, extend the reviewed backup scope **before** running Git. A tar of linked worktrees is **not automatically a standalone restorable Git repository**; preserve the original `.git`/worktree links and test restore into a disposable location before treating it as a disaster recovery guarantee. Shared Memory PostgreSQL backup/restore is tracked separately in [#48](https://github.com/sauron9521/gym-dev-hub/issues/48). Record **backup existence and verified checksum only**, not private files or secret values.

## Step 3 — explicit owner fast-forward (not part of this PR)

With running services **stopped gracefully**, a verified backup, independently confirmed latest GitHub main SHA, and a still-green source preflight on the same HEAD:

```sh
cd /home/sauron/Projects/gym-dev-hub
# This fetch does not change the checked-out local main.
git fetch --no-tags https://github.com/sauron9521/gym-dev-hub.git main
MAIN_SHA="$(git rev-parse FETCH_HEAD)"
# Re-run the *new trusted* preflight as in Step 1, on exact MAIN_SHA.
# Owner explicitly reviews and authorizes ONLY this fast-forward:
git merge --ff-only "$MAIN_SHA"
test "$(git rev-parse HEAD)" = "$MAIN_SHA"
```

A non-overlapping **fast-forward preserves dirty tracked files and ignored/untracked paths**; if Git refuses, **stop** and inspect rather than stashing or resetting. Do not run a checkout with `-f`, remove `.worktrees`, prune Git worktrees, regenerate secrets, overwrite `.env` or change the target Gym Platform checkout.

After the merge, install pinned dependencies according to the current trusted source (`pnpm install --frozen-lockfile` if necessary) and run `pnpm check`. If dependency changes require work on local state, review their scope before proceeding.

## Step 4 — safe restart and acceptance

Only after the user approves taking down the known Hub operator supervisor: terminate that **specific** supervisor gracefully, ensure only its owned processes exit, and start the updated `pnpm dev:operator` under an operator session with verified Docker group access (e.g. `sg docker -c 'pnpm dev:operator'`). **Do not** launch a second process while `3100/3101` are already listening. Avoid `sudo pnpm`, public bind and `chmod 666 /var/run/docker.sock`. Recheck:

- `GET http://127.0.0.1:3101/health/live` HTTP 200, Web `http://127.0.0.1:3100` HTTP 200;
- `GET /workspace/sessions/workflow-readiness` must show exact matching `source.localHeadSha === source.githubMainSha === current main SHA` and `source.state=configured`; **no guarantee** that Docker/GitHub write permissions or E2E smoke are verified;
- compare original tracked-file checksums with backups, verify `.env`, `.worktrees`, `apps/api/.local` and their audit/worktree links remain present; do not read or print their contents into GitHub;
- `pnpm check` and any controlled restart/smoke should match the new exact source; if anything fails, document the regression and owner-approved recovery without destructive resets.

**Issue #106 remains OPEN** until the owner-controlled fast-forward, private backup verification, actual running source alignment and readiness HTTP recheck have occurred. Passing local tests or merging a preflight PR **does not** establish that acceptance.
