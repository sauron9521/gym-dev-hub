# Gym Dev Hub → Gym Platform: launch & daily-use roadmap

> **Canonical delivery plan:** [Launch Epic #105](https://github.com/sauron9521/gym-dev-hub/issues/105) and Issues #106–#117. This is a **Linux Mint, single-trusted-operator first** release. Its target is `sauron9521/gym-platform`, but implementation lives **only** in `sauron9521/gym-dev-hub`. New Gym Platform code is created **only** by later, separately owner-authorized worktree/PR operations.
>
> **Status as of 2026-11-21:** planning complete; **M0/M1/M2 not yet accepted**. New issues and this roadmap **do not** grant new permissions or indicate successful end-to-end testing. The repository owner manually reviews and merges every PR.

## Product outcome

The owner selects a small Gym Platform task and reviews its scope, current GitHub `main` SHA, allowed files, patch, fixed non-networked checks, commit and Draft PR **through the Hub**. The resulting GitHub PR targets **Gym Platform** `main`; its CI is checked on the **exact current PR head SHA**. The Hub cannot merge, force-push, mutate the developer's existing checkout, or execute unreviewed agent commands.

### Release boundaries

| Mode                                    | Goal                                                                                                | Release threshold                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **M0: Local trusted operator**          | Hub setup is stable on a trusted workstation, can safely recover and complete a Hub self-repo pilot | #106–#108 accepted, including live Docker and Draft PR evidence                                                                |
| **M1: Gym Platform controlled pilot**   | One complete **real single-file** Gym Platform Draft PR via Hub with green exact-head CI            | #109–#113 accepted and owner-reviewed                                                                                          |
| **M2: Daily Gym Platform use**          | Controlled multi-file PRs, durable recovery, operator UX, backups and repeatable acceptance         | #114–#117 accepted and owner go/no-go                                                                                          |
| **M3: Parallel agents / Shared Memory** | Leases, live events, relevant approved Codex context, UI/MCP/3-agent test                           | Existing separate [Epic #34](https://github.com/sauron9521/gym-dev-hub/issues/34) and Issues #40–49 — **not a blocker for M1** |

**Do not claim “production ready” after M0 or M1:** the target is a **trusted personal developer workstation**, not a public multi-user, remote administration, SaaS or unattended agent product.

## Verified baseline — 21 November 2026

- GitHub `gym-dev-hub/main`: `85bae423284fd93e278d2b1ce8aefd208c6b48f6` (owner-merged PR #104). Re-check this SHA whenever work starts.
- API `http://127.0.0.1:3101/health/live` and dashboard `http://127.0.0.1:3100` returned **HTTP 200** during the audit.
- Primary local checkout HEAD was `957aafc0b42d41ffc6c5f90617a425ba6452fbec`; **tracked modifications** to `turbo.json` and `apps/web/next-env.d.ts` plus untracked `.worktrees/` exist. **Preserve all three; don't run `git reset --hard` or `git clean -fd`.**
- Live `GET /workspace/sessions/workflow-readiness` returned **10/11 configured** but `source=blocked` due local/GitHub SHA mismatch; `preconditionsSatisfied=false`, `endToEndVerified=false`, `githubPermissionsVerified=false` and `dockerExecutionVerified=false`. **Configured is not tested or authorized.**
- On the observed normal user shell `docker ps` failed with **permission denied on `/var/run/docker.sock`**. This is not proof that Docker itself or the already-running API process is broken. Test the relevant operator process explicitly.
- Local `pnpm dev:operator` exists: stable prebuilt API (no Nest watch) + Next.js Web HMR; requires Docker group access and free ports. [Issue #79](https://github.com/sauron9521/gym-dev-hub/issues/79) records the Docker snapshot→Nest watch restart incident and a workaround.
- Existing Hub self-repo prototype can handle **one previously reviewed existing file**, separate one-use operator grants, pinned worktree/hydration, fixed Docker FORMAT/TEST/TYPECHECK receipts, controlled Git commit, create-only branch publish, Draft PR and read-only CI. Its allowlists and write grants **must not silently become Gym Platform permissions**.
- Existing [Shared Agent Memory](https://github.com/sauron9521/gym-dev-hub/issues/34) has real durable repository-scoped records, read/proposal/approval and recent personal operator approval/rejection PRs, but **does not yet inject the right approved context into every independent Codex turn or coordinate task leases**.

## M0 — local trust and known-good baseline (P0)

| Order | Issue                                                                                      | Deliverable                                                                                                         | Acceptance gate                                                                       |
| ----- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1     | [#106: safe checkout reconciliation](https://github.com/sauron9521/gym-dev-hub/issues/106) | Inventory and preserve dirty checkout/worktrees/private state; safely align operator source with actual GitHub main | No lost files, source readiness configured, working API/Web and `pnpm check`          |
| 2     | [#107: stable operator/Docker](https://github.com/sauron9521/gym-dev-hub/issues/107)       | Stable API + Web HMR, actual authorized Docker access, bounded fixed checks                                         | No watch disconnect, exact audited passed receipts; coordinate with existing #79      |
| 3     | [#108: Hub golden E2E](https://github.com/sauron9521/gym-dev-hub/issues/108)               | Run a safe live operator-controlled self-repo worktree→test→commit→Draft PR→CI                                      | Recorded exact head SHA/receipt/run/CI evidence and owner review; no duplicate/replay |

### M0 operator acceptance

1. Take a **read-only** inventory of Git HEAD/branch, dirty files, local worktrees, ignored `.env`, Workspace JSON/audit journals and running services. Back them up **outside Git** without printing or pasting secrets.
2. Bring **only** the trusted operator checkout to actual current `main` using a **reviewed**, non-destructive update. Never use a source mismatch as permission to discard local work. Stop/restart Web/API at the new checkout after all safety checks.
3. Set up `pnpm dev:operator` correctly. **Stop the currently running local ports** only after verifying they belong to this Hub, and only with operator consent. Do not use `sudo pnpm`, world-readable Docker socket mode or public bind.
4. Recheck `/workspace/sessions/workflow-readiness` (11 configured is necessary, **not sufficient**). Execute real fixed Docker checks in a disposable worktree and verify the corresponding persisted, SHA-bound pass receipts.
5. Create **one owner-approved disposable Hub Draft PR** and check GitHub's actual final-head CI. Do not auto-ready/merge. Test an intentional denied or interrupted operation and a read-only recovery.

**Stop conditions:** any unknown GitHub/write outcome, wrong repo or main SHA, missing pin, changing file outside the approved scope, failed audit, Docker network/identity mismatch, or missing secret isolation → **halt writes, inspect read-only**.

## M1 — Gym Platform target pilot (P0)

| Order | Issue                                                                                    | Scope                                                                                             | Must demonstrate                                                                   |
| ----- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 4     | [#109: repo-scoped target policy](https://github.com/sauron9521/gym-dev-hub/issues/109)  | Exact allowlists, separated read/write rights, per-target grant bindings                          | A Hub grant cannot mutate Gym Platform and vice versa                              |
| 5     | [#110: pinned Gym Platform source](https://github.com/sauron9521/gym-dev-hub/issues/110) | Current Gym Platform `main` source/tree, separate worktree and raw-blob integrity                 | Existing developer Gym Platform checkout stays untouched                           |
| 6     | [#111: fixed Gym Platform recipes](https://github.com/sauron9521/gym-dev-hub/issues/111) | Approved API/Web FORMAT, TEST/TYPECHECK with pinned Node/pnpm/lock/dependencies, isolated Docker  | Green receipts only for exact reviewed source; no arbitrary commands               |
| 7     | [#112: task branch and Draft PR](https://github.com/sauron9521/gym-dev-hub/issues/112)   | Distinct Gym Platform Contents/PR credentials, SHA-confirmed create-only publish, manual Draft PR | No force-push, cross-repo, main write or duplicate PR                              |
| 8     | [#113: first real Gym Platform PR](https://github.com/sauron9521/gym-dev-hub/issues/113) | Safe one-file code/doc/test slice, reviewed diff, fixed checks, commit, branch, PR, final-head CI | **Owner-approved real PR** and retained evidence. This is the **M1 go/no-go gate** |

### Target repo policy

- **Dashboard read** for both `sauron9521/gym-dev-hub` and `sauron9521/gym-platform` is not permission to **write** to both.
- Each target's exact canonical Git origin, trusted local root, GitHub `main` head SHA, branch, file scope, worktree, patch fingerprint and purpose-bound grant must be checked at **review and commit time**.
- Prefer fine-grained **Gym Platform-only** GitHub tokens: distinct `Contents:write` for create-only branch and `Pull requests:write + Contents:read` for Draft PR; no Admin, Actions:write, force push, main write or merge permission.
- Immutable source snapshots and isolated runner images **remain per exact lockfile/commit**, not a stale pinned older Gym Platform commit. Updated source requires a new reviewed pin and verification.
- For the first pilot, choose a **small non-sensitive one-file task** (simple test, UI text or a documented, owner-approved noncritical fix). Avoid schema migrations, auth, CI infrastructure, lockfile changes or bulk refactors until M2 controls.
- This plan **does not request a real GitHub write now**. A future operator action requires the owner to authorize a particular safe PR and enter secrets locally. Never paste credentials into issues or chat.

### M1 release evidence

Record **metadata only** in [#113](https://github.com/sauron9521/gym-dev-hub/issues/113): exact Hub/Gym Platform main SHA, approved plan/receipt IDs, target `devhub/task-*` branch, expected commit/tree hashes, Draft PR URL, final PR head SHA and GitHub check URL/conclusion. Record the absence of unexpected dirty files and that owner review/merge remained manual. No bearer, environment variables, secret contents, raw prompts or private log dumps.

## M2 — routine operation after a successful M1 pilot (P1)

| Order | Issue                                                                                     | Why needed                                                    | Acceptance                                                                                                |
| ----- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 9     | [#114: multi-file atomic slices](https://github.com/sauron9521/gym-dev-hub/issues/114)    | Real Gym Platform work commonly spans API/Web/shared packages | All files reviewed together, no partial hidden mutation; format/check receipts on full post-patch tree    |
| 10    | [#115: durable recovery](https://github.com/sauron9521/gym-dev-hub/issues/115)            | API restarts, Docker interruption, lost GitHub replies        | Read-only reconcile and explicit operator resume; no auto-replay or duplicate PR                          |
| 11    | [#116: task wizard and states](https://github.com/sauron9521/gym-dev-hub/issues/116)      | Cut manual setup and prevent false “green” states             | Owner sees exact repo/branch/receipt/PR/CI status, blocked states and recovery steps                      |
| 12    | [#117: backups + 3 accepted cycles](https://github.com/sauron9521/gym-dev-hub/issues/117) | Prove daily-use reliability and restore                       | Three independent Gym Platform PR workflows, verified backup/restore, live failure drills, owner go/no-go |

**Definition of done for “daily use”:** M1 passed; #114–#117 accepted; no manual bypass of operator safeguards; tests pass on each final PR head; recovery is documented for lost response; a real **restore** succeeds without corrupting main or known local notes.

### Operational checklist per task

1. Review current Hub and target GitHub main SHAs and health; check pending PRs and conflicts.
2. Identify one issue, expected files and acceptance; pick a new isolated task/worktree and reviewed source SHA.
3. Explicitly authorize just the required narrow read/patch/check/commit/publish/PR stages; do not disclose any secret.
4. Apply a reviewed, bounded diff; run relevant fixed FORMAT + TEST/TYPECHECK in verified non-networked Docker.
5. Review full audit, source/target/lockfile status and exact candidate Git tree. If changed, invalidate stale grants/receipts.
6. Owner-authorized commit + create-only task branch + one Draft PR; verify real GitHub exact-head CI and reviewer decision.
7. Owner personally reviews, adjusts/merges/closes PR; close issue only after matching acceptance and main verification.
8. On any ambiguous action, **STOP** and inspect remote/read-only state; don't retry consumed grants or remove recovery locks blindly.

## M3 — optional parallel agents, independent from first Gym Platform launch

Follow [Epic #34](https://github.com/sauron9521/gym-dev-hub/issues/34), not a new duplicate issue hierarchy:

- [#40](https://github.com/sauron9521/gym-dev-hub/issues/40): finish personally attributed verified revoke/supersede and lifecycle hardening.
- [#41](https://github.com/sauron9521/gym-dev-hub/issues/41): per-task/per-path leases and conflicts, especially `pnpm-lock.yaml`, Prisma migrations and shared contracts.
- [#42](https://github.com/sauron9521/gym-dev-hub/issues/42): transactional events and cross-session SSE replay.
- [#43](https://github.com/sauron9521/gym-dev-hub/issues/43) → [#44](https://github.com/sauron9521/gym-dev-hub/issues/44): trusted, source-linked compact context and per-Codex-turn injection.
- [#45](https://github.com/sauron9521/gym-dev-hub/issues/45): shared-memory UI/approval workflow; [#46](https://github.com/sauron9521/gym-dev-hub/issues/46) and [#47](https://github.com/sauron9521/gym-dev-hub/issues/47): independently permission-gated external MCP read and proposed-only write.
- [#48](https://github.com/sauron9521/gym-dev-hub/issues/48): shared-memory database backup/restore and safe legacy JSON import; [#49](https://github.com/sauron9521/gym-dev-hub/issues/49): actual **three-agent** E2E and rollout acceptance.

**No implicit ChatGPT cross-chat sync**: independent external chats need a real supported connected MCP client and tool calls; without those, context is not shared automatically. Memory proposals from agents are untrusted until separately operator-approved.

## Existing issues not to duplicate

| Issue                                                                                           | Role in this roadmap                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [#79](https://github.com/sauron9521/gym-dev-hub/issues/79) — Nest watch Docker snapshot restart | M0 #107 dependency/workaround; investigate bug, not a new duplicate issue      |
| [#59](https://github.com/sauron9521/gym-dev-hub/issues/59) — Windows Docker pnpm store          | Windows follow-up only; not a Linux Mint M1 blocker                            |
| [#34](https://github.com/sauron9521/gym-dev-hub/issues/34) — Shared Agent Memory epic           | M3 parallel; do not mark complete based on M1                                  |
| [#48](https://github.com/sauron9521/gym-dev-hub/issues/48) — shared-memory operations           | Complement to #117 **workspace/operator** backup, not the same scope           |
| Previously addressed formatting blocker #81                                                     | Covered by required fixed `*_FORMAT` receipts; don't reopen without regression |

## Delivery discipline

- **One small PR after the previous one is owner-merged**: check the actual `main`, issue prerequisites, exact current SHA and changed paths before the next task. Never merge on behalf of the owner.
- In each PR: one user-visible behavior, localized tests + negative/fault paths, updated docs and issue criteria; ensure GitHub required checks green **on the final commit**, report any skipped real integration tests explicitly.
- Do not mark `Ready for Merge` if a required offline Docker scenario, actual GitHub permission, or real target repo smoke is still unverified.
- No broad repo permissions, remote network binding, direct Gym Platform main writes, arbitrary host shell/Git, auto-merge or network access inside untrusted runner.
- M0/M1 completion needs real owner-reviewed evidence, not configuration-only “configured” or mocked tests.
- If an existing issue proves complete in current `main`, update its checklist and link the exact PR and acceptance evidence rather than reproducing work.

**First work item:** [#106](https://github.com/sauron9521/gym-dev-hub/issues/106), a **non-destructive** local checkout/state reconciliation. Finish it before running write-capable operator flows on the newer main.
