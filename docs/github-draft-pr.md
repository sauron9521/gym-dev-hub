# PR #70 — manually authorized GitHub Draft Pull Request and CI review

This is a **localhost trusted-operator pilot** that follows the exact
one-file pipeline from PRs #63–69: scoped worktree, approved patch,
Git/Docker checks, reviewed candidate, local commit and published
task branch. This feature creates **one draft GitHub Pull Request**
to `main`. It **never** merges, marks a PR ready, edits the branch,
updates other PRs, force-pushes or executes arbitrary Git commands.

## Configure a separate, limited credential

OFF by default. Set these only in the ignored `apps/api/.env` on
your own local machine:

```ini
DEV_HUB_ENABLE_DRAFT_PR=true
DEV_HUB_DRAFT_PR_OPERATOR_SECRET=<new independent 32–256-byte secret>
DEV_HUB_DRAFT_PR_TOKEN=<fine-grained token for this repository, Pull requests:write>
```

Create a **separate** GitHub credential scoped only to
`sauron9521/gym-dev-hub`, with Pull requests **write** and Contents **read** (needed for the GitHub compare API),
and no unnecessary administration permissions. This does not reuse
`GITHUB_TOKEN` or `DEV_HUB_GITHUB_PUBLISH_TOKEN`. The browser
receives neither token. The operator enters only the independent
Draft PR secret, separately at each step.

The existing local Git and GitHub push audit files must already
contain the exact successful events from PRs #68–69 for the same
session, plan, branch, SHA and original commit parent.

## Manual operation in Workspace

The Draft PR panel appears only after the Workspace UI has received a
confirmed successful GitHub task-branch publication:

1. Confirm the published `devhub/task-<32hex>` branch and SHA.
   Check the explicit consent box, enter the Draft PR operator
   secret and choose **Дозволити один Draft PR**. Server independently
   verifies local HEAD, audited local commit and successful branch
   publication, GitHub remote ref at the same SHA, the branch's one
   commit ahead of `main`, and lack of previous PRs using that head.
   An in-memory **45-second, one-use** grant is issued. No PR yet.
2. Re-enter the secret and choose **Створити цей Draft PR**.
   The grant is consumed before any async work. The same per-plan
   disk lock as the commit/publish services is acquired, the
   operation is audited, and all state checks are repeated. The
   service sends a **single POST /pulls** with
   `draft: true`, `base: main`, the fixed task head branch,
   the exact previously reviewed Conventional Commit subject as
   title, a fixed server-generated review body, and
   `maintainer_can_modify: false`.
3. The service checks GitHub's response and re-reads the PR to
   verify it is open, **draft**, has the exact SHA/title/head/base,
   records the PR number, and releases the lock. The UI then
   shows the GitHub PR link plus a **read-only CI check** button.
   CI is **not automatically assumed successful**.
4. Click **Перевірити CI** or **Оновити CI**. This calls the existing
   GitHub PR readiness engine, scoped to the same audited SHA;
   it displays actual checks, required checks, verdict and data
   availability. The existing Hub
   `/pr/<number>?repository=sauron9521%2Fgym-dev-hub` view provides
   the full details. It is not an automated merge decision.

Only these new typed POST routes are accepted:

```text
/workspace/sessions/:sessionId/worktree-plans/:planId/github-draft-pr-authorize
/workspace/sessions/:sessionId/worktree-plans/:planId/github-draft-pr-execute
/workspace/sessions/:sessionId/worktree-plans/:planId/github-draft-pr-ci
```

Authorization body: `commitSha`, `operatorSecret`, and
`confirmation: "I_AUTHORIZE_CREATE_ONE_DRAFT_PR_ONLY"`.

Execution body: `grantId`, `grantToken`, `runId`,
`operatorSecret`, and
`confirmation: "I_CREATE_THIS_EXACT_GITHUB_DRAFT_PR"`.

Read-only CI: `prNumber`, `commitSha`. No action accepts arbitrary
PR title/body, target base, remote, URL, Git arguments, force,
merge, permissions or branch overrides.

## Safety and recovery

The service queries GitHub for previous **open, closed or merged**
PRs using the same head branch (not just drafts); a duplicate,
incomplete response, SHA mismatch, or changed local/remote state
stops the operation. The Draft PR is created via GitHub's
standard pull request endpoint; no merge endpoint or branch update
method is implemented.

Private `apps/api/.local/commit-write/github-draft-pr.jsonl` (or
`DEV_HUB_COMMIT_STATE_DIR`) is a bounded, fsynced metadata-only
journal with `issued`, `attempted`, `created`, `rejected` events,
plan/session IDs, SHA and optional PR number. It never stores secrets,
tokens, the PR title/body, diff or source code.

If GitHub times out or returns an unexpected result **after** the
POST attempt, treat the outcome as unknown: **do not retry**.
The per-plan `<planId>.lock` stays in place, requiring manual
inspection of GitHub pulls, the verified task ref and local audit.
GitHub might have created a Draft PR despite a lost HTTP response.

The repo's GitHub readiness uses a short-lived cache and can report
`pending` or `unknown`; neither is proof of passing CI. Even if
all required checks pass, the PR remains draft until a human takes
the separate appropriate actions in GitHub.

**Verification:** Mocked GitHub API tests cover one draft only,
duplicate detection, ref SHA drift, changed commit compare results,
invalid/non-draft response, lost request and re-verification.
Grant and audit tests cover opt-in, credential isolation, replay,
concurrency, unknown outcomes and read-only CI validation.
A real-token browser + GitHub end-to-end smoke **is still required**
before relying on it in daily work.
