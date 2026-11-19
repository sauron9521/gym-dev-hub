# Agent working agreement

- One implementation slice = one branch = one pull request.
- Never push directly to `main`; never merge or enable auto-merge.
- Prefer small, reviewable changes with explicit acceptance criteria.
- Run lint, typecheck, tests and relevant builds before marking a PR ready for review.
- After changes to a PR branch, re-check CI for the **latest head SHA**.
- Do not copy secrets, tokens, environment files, private conversation data, or local absolute paths into commits or logs.
- Do not change other repositories unless the user explicitly requests it.
- Code-running agents must be isolated by worktree; review agent should not modify source.
