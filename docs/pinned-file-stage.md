# Ephemeral pinned single-file staging (PR #18)

This PR closes the worker's UID `65534` file-permission gap **without chmod/chown on the original hydrated worktree**. It is a bounded one-file snapshot, not a general workspace mount or arbitrary command runner.

## Local opt-in

In the ignored `apps/api/.env`, explicitly add:

```dotenv
DEV_HUB_ENABLE_PINNED_FILE_STAGE=true
```

The existing independent opt-ins, strong operator secrets, 60-second one-use grants, Docker preflight and worktree-integrity checks from PRs #15–17 still apply. Staging **does not grant access** unless the relevant read or tool approval was issued. Without this additional flag, code-reading and fixed-tool requests fail closed; the original PR #15 read-only mount probe is unchanged.

## Snapshot and lifecycle

1. The request verifies its session, plan, fingerprint, pinned commit, file selection and one-time grant, rechecks Git blob integrity, and records a `code-read-started` or `tool-run-started` audit entry.
2. The staging helper accepts **one normalized allowlisted relative path** only. It checks the original regular file is at most **8 KiB** but reads data from its **pinned Git commit object**, not from a potentially modified or unreadable working-tree file.
3. Using fixed no-shell `git cat-file blob <commit>:<file>`, with global configuration, lazy network fetching and prompts disabled, it loads no more than 8192 bytes. A blob-size mismatch causes failure.
4. The helper creates a cryptographically unpredictable, new, one-use sibling directory `.gym-dev-hub-stage-*` beside the worktree. Only the selected file's **basename** is copied, with exclusive creation. The directory has mode `0711` (traversable but not listable to others), and its sole file has mode `0644` for non-root Docker access. There is no full-repository copy. The original file modes and content stay unchanged.
5. Docker mounts **only this temporary directory** read-only under `/workspace`. Existing image pinning, local-engine validation, no-network, no-capability, read-only rootfs, UID 65534, CPU/PID/memory limits, observed mount checks and daemon-side container removal remain in place.
6. The worker can perform one pre-approved `READ/1 <basename>` or `CHECK/1 SHA256 <basename>`. API checks the returned text/digest matches the **exact immutable staged Git bytes**. It rejects unexpected output.
7. Even on an error, the helper unlinks **only the file it exclusively created**, then removes the empty one-use directory with `rmdir`, never recursive deletion. If either step fails, the operation fails; investigate residual `.gym-dev-hub-stage-*` directories manually.

## Security and privacy limits

- Snapshot contents are temporarily world-readable by filesystem mode, although the random stage directory is not listable. **Only explicitly approved small tracked files** should be staged; do not select files containing credentials. No staging mechanism can protect against an already-compromised local administrator.
- The snapshot exists solely during the one Docker request. The process crashing (hard kill, power loss) can leave an orphaned stage. This PR deliberately does not run automatic destructive recovery; manually inspect and delete abandoned staging directories once identified.
- Docker Desktop Windows file sharing and NTFS permissions **do not fully follow POSIX chmod semantics**. The Linux integration test demonstrates the intended POSIX behavior; a real Home-PC Docker Desktop check is still required. Failure must be handled as rejection, never by mounting an entire private directory or weakening original permissions.
- The source path's pinned Git object is used only after the existing full worktree integrity check. This is not an OS-enforced immutable snapshot of a hostile Git object store under a malicious local admin.
- No Codex execution, shell commands, install scripts, Git writes, automatic PRs or merges are enabled.

## Verification

API unit tests create a real temporary Git repository and assert the staged bytes equal the pinned commit, original mode `0600` is preserved, only one file is staged, and cleanup occurs even on worker failure. Windows CI runs staging tests. Dedicated Linux Docker CI verifies a UID-65534 worker can read and checksum the temporary snapshot while the original remains mode `0600`.

**Next:** review and test a safe, explicitly allowlisted task-runner architecture. Arbitrary execution stays disabled.
