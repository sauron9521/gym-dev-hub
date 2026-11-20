# Development milestones

1. **Bootstrap**: pnpm/Turborepo, Next.js, NestJS, shared packages and CI (PR #1, merged).
2. **Repository dashboard**: GitHub read-only PR/Issue/Milestone/Actions views, per-repository switching, explicit partial failures (PR #2).
3. **PR checks drill-down**: current head-SHA check runs, legacy commit statuses, classic required checks, conservative review readiness, short-lived cache (PR #3).
4. **GitHub data reliability**: GitHub Rulesets, review approvals, full required-check evaluation, pagination, rate-limit improvements and optional read-only GitHub App installation, in small follow-up PRs.
5. **Agent workspace foundation**: local persistent sessions, parallel tabs, task states and notes (PR #4).
6. **Codex adapter foundation**: optional local app-server handshake, persisted read-only thread bindings and connection health (PR #5).
7. **Agent Chat (read-only)**: streamed Codex text turns over SSE, local chat history and failure handling (PR #6).
8. **Execution boundary preflight**: local Linux Docker status, pinned test image, read-only/no-network/no-mounts probe, fail-closed capabilities (PR #7).
9. **Isolated worker foundation**: locally built dedicated worker image, fixed HELLO/PING/SHUTDOWN protocol, lifecycle and fail-closed Docker policies (PR #8).
10. **Worktree manifest & acknowledgement**: allowlisted local source/repository validation, immutable planned worktree paths, fingerprinted review, TTL and revocation, without Git mutations (PR #9).
11. **Metadata-only worktree creation**: explicit local operator secret, SHA-pinned single-use grant, safe Git worktree registration without checkout, state/audit recovery (PR #10).
12. **Worktree recovery and hydration preflight**: read-only Git metadata checks, tree safety scan, no auto cleanup and no checkout (PR #11).
13. **Gated raw Git blob hydration**: separate operator-secret grant, pinned blob read, exclusive bounded writes, durable progress and failure state (PR #13).
14. **Post-hydration integrity & mount preview**: read-only Git blob hashing, extra-file detection and a non-executing scoped mount policy (PR #14).
15. **Ephemeral read-only worker mount**: distinct operator approval, pinned image, fixed protocol and read-only bind validation with mandatory container cleanup (PR #15).
16. **Scoped code reading**: separate one-time operator consent for one bounded source file in a temporary read-only Docker worker; Docker Desktop mount identity checks, no arbitrary commands (PR #16).
17. **Fixed controlled worker tool**: independently approved, one-shot SHA256_FILE capability in isolated Docker; no source code execution or arbitrary commands (PR #17).
18. **Safe worker file access**: independently enabled single-file, SHA-pinned temporary staging for non-root worker, no chmod on original worktree and mandatory cleanup (PR #18).
19. **Fixed task-runner policy preview**: preview six verified gym-platform pnpm recipes with exact argv, pinned worktree identity, and explicit proposed isolation. No execution (PR #19).
20. **Isolated Node runner foundation**: dedicated Node.js 24 / pnpm 12.18.0 diagnostic image, fixed non-executing protocol, verified Docker restrictions and immutable image policy; no project scripts (PR #20).
21. **Offline dependency provisioning proof**: reproducible, fixture-only pnpm workspace preparation with `--offline --frozen-lockfile --ignore-scripts` under a no-network read-only Docker boundary; native dependency builds remain blocked (PR #21).
22. **Pinned dependency cache integrity proof**: independently pinned SHA-512 SRI, immutable input manifest verification, content-addressed compressed archive in private tmpfs, tampering denial. Fixture-only, no package execution (PR #22).
23. **Real Gym Platform dependency manifest audit**: fixed, commit- and Git-blob-pinned read-only review of both pnpm 12 lockfile documents, all SHA-512 resolutions, native build allowances and audit exceptions; no installs (PR #23).
24. **One real npm artifact provenance**: fetch one reviewed, SHA-512-pinned `gym-platform` registry tarball in a trusted CI stage and verify/stage it in networkless Docker without extraction or scripts (PR #24).
25. **Real offline two-package install**: populate a short-lived pnpm cache from two independently pinned real Gym Platform dependencies in trusted CI, then install the fixed transitive graph offline in Docker without lifecycle scripts, with negative cases (PR #25).
26. **Pinned TypeScript toolchain smoke**: provision real Gym Platform `typescript@6.0.3` offline and execute a fixed positive/negative TS compiler fixture under networkless Docker CI, with no target repository source or API execution (PR #26).
27. **Controlled execution (future)**: separately approved broad real cache, native build strategy, immutable source snapshot, safe test runner with bounded outputs and review; no auto-merge.
28. **PR lifecycle**: task-to-draft-PR workflow, local checks, CI feedback and review gate.
29. **Orchestration**: task dependencies, safe parallel scheduling, recovery and multi-repo support.

Deliver each milestone as small, reviewable pull requests. The owner performs every merge manually.
