# Manual Git commit candidate review — PR #67

This is a **read-only, opt-in** planning and human-acknowledgement feature
built on PRs #64–66. It **does not** run `git add`, `git commit`,
`git push`, open a pull request, change branches, or merge anything.

## What is reviewed

After a single-file approved patch and a verified post-apply Git review,
the operator may form a commit _candidate_ for the Gym Dev Hub repository.
The server independently confirms:

- One approved `apps/api/src/**` or `apps/web/src/**` file, exactly the
  pinned original commit/fingerprint and approved post-image SHA-256
- PR #64's **actual read-only Git diff**, including rechecking whole-tree
  integrity and no unexpected file changes
- The PR #66 private audit, with **at least one successful** corresponding
  PR #65 fixed Docker check for the same source/post-image hashes,
  fingerprint, repository session and worktree plan
- A human-authored single-line Conventional Commit title of 10–72
  characters, such as `fix(api): validate source upload`

The candidate response includes the **actual Git diff**, its SHA-256,
candidate SHA-256, the requested commit title, the list of matching passed
recipes and **any missing second recipe**. One passing recipe is the
minimum for preview, not a claim that all tests have run or that the code
is ready for production.

## Opt-in and permissions

Default OFF. Configure independent credentials in a private local env:

```text
DEV_HUB_ENABLE_COMMIT_CANDIDATE_PREVIEW=true
DEV_HUB_COMMIT_CANDIDATE_OPERATOR_SECRET=<new independent random 32+ character value>
```

The existing patch-apply review gate and its secret must already be
configured, and the fixed Docker checks must previously have been
executed and recorded. These are **local operator credentials**; do not
store them in source control, expose the Hub to the public internet, or
send them to an agent. No new GitHub credential is required for this PR.

The API exposes exactly two **POST**, strict-body, operator-authenticated
endpoints:

```text
POST /workspace/sessions/:sessionId/worktree-plans/:planId/commit-candidate-preview
POST /workspace/sessions/:sessionId/worktree-plans/:planId/commit-candidate-acknowledge
```

The first checks the Git tree, diff, audit and message, returning a bounded
read-only candidate with an in-memory five-minute validity period. The
second **consumes the candidate once**, requires both operator secrets
again plus the literal confirmation
`I_REVIEWED_THIS_COMMIT_CANDIDATE_ONLY`, and **rechecks the actual diff and
the check audit** before returning the informational
`status: 'operator-reviewed'` receipt. The acknowledgement does not
issue a Git write grant; it is intentionally lost when the API restarts.
Replay, stale candidates, changed messages, changed diff/hashes or
changed check status fail closed.

The Workspace panel appears after a verified patch and one successfully
executed fixed check. Secrets are cleared from form state on submission.
The UI displays the real diff and any missing tests. It cannot commit
anything. The current one-result-at-a-time check panel may need
additional work before a human can run both API/Web checks sequentially
on the same patch; this PR does not claim missing checks passed.

### Threat model and follow-up

Git data, tests and state must remain local/trusted. The feature inherits
the independent PR #64 Git audit and integrity controls and PR #66's
bounded local audit (not cryptographically tamper-evident). An operator
confirmation is **not** a substitute for a final pre-commit revalidation.

A future, _separate_ PR could introduce actual operator-authorized
staging/commit with a fresh explicit one-time permission, pinned
worktree state, hooks/filters disabled, its own tests and audit. Even
then, no automatic push or merge should be implied.
