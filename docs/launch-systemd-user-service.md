# Gym Dev Hub: optional systemd user service (Linux)

This is an **opt-in** startup mechanism for the already approved local
`scripts/dev-operator.mjs` supervisor. It preserves the current architecture:
compiled API (no Nest watch), Web HMR, localhost ports 3101/3100, private
operator environment and operator-owned Docker. It **does not** automatically
grant any API/Docker operation, rewrite Git, apply patches, touch the target
Gym Platform checkout, or make a workflow `endToEndVerified`.

## What is implemented in PR #134

`scripts/launch-systemd-user-unit.mjs` has **only two read-only modes**:

```sh
cd ~/Projects/gym-dev-hub
node scripts/launch-systemd-user-unit.mjs --check-only \
  --operator-checkout="$PWD"

node scripts/launch-systemd-user-unit.mjs --print-unit \
  --operator-checkout="$PWD"
```

The tool validates the **primary**, canonical, same-owner Git `main`
checkout and trusted remote (not a linked worktree), known `dev:operator`
entrypoint, Node 24+ absolute executable and pnpm 12.18.0. It renders
an owner-specific unit with absolute paths and a pinned `PATH`.
Path metacharacters, shell interpolation, unexpected Git origins and
unsupported package metadata are rejected.

The generated user unit uses `Type=exec`, `WantedBy=default.target`,
`Restart=on-failure`, 45-second restart delay and **at most 2 starts in
10 minutes**. These are bounded attempts, _not_ infinite recovery or
confirmation the services are healthy. The existing supervisor checks
actual Docker access, rejects remote Docker contexts and occupied ports
**before** starting either API or Web. The unit does not terminate any
pre-existing service to claim its ports.

`KillMode=control-group` and `TimeoutStopSec=12s` restrict systemd
shutdown/timeout escalation to the unit's own subprocesses. This allows
the existing supervisor to gracefully stop its owned API/Web groups.
Do not launch a second instance by enabling `--now` while the
existing manual supervisor is still using the same ports.

No .env contents are embedded in the unit, and there is **no
`EnvironmentFile`**, shell wrapper, `sudo` or world-readable Docker
socket workaround. The API still reads its existing private configuration
through the unchanged application startup process. Note that systemd
journald can contain ordinary API/Web/build diagnostic output: review logs
privately before sharing them.

## Owner-controlled installation, only after approving a service handover

The PR does **not** install a file under
`~/.config/systemd/user`, call `systemctl`, enable a user service,
change `loginctl linger`, or stop/restart the existing Hub.

After **owner review and manual PR merge**, safely update the primary
checkout to the merged main using the documented backup and quiet-process
checks. During an explicitly approved maintenance window:

1. Check that the intended existing Hub supervisor can be safely stopped,
   and stop **only that owner-verified supervisor** (if still running)
   using the previously approved manual shutdown mechanism. Verify
   ports 3100/3101 and process inventory are clear.
2. Run `--check-only` and read the reported SHA-256; run
   `--print-unit` and review the unit source. This is also where you
   check that the absolute Node path is still correct after upgrades.
3. Install the reviewed unit **only if there is no pre-existing unit**
   (the `noclobber` shell mode below refuses overwrite):

```sh
cd ~/Projects/gym-dev-hub
umask 077
mkdir -p "$HOME/.config/systemd/user"
(
  set -C
  node scripts/launch-systemd-user-unit.mjs --print-unit \
    --operator-checkout="$PWD" \
    > "$HOME/.config/systemd/user/gym-dev-hub-operator.service"
)
systemd-analyze verify "$HOME/.config/systemd/user/gym-dev-hub-operator.service"

# Separate owner authorization to activate it is required.
systemctl --user daemon-reload
systemctl --user enable --now gym-dev-hub-operator.service
```

If `--print-unit` or verification fails, do **not** enable the
unit: inspect the local file and repair or remove only that newly
created unit. Never overwrite an existing service definition
automatically. For source/Node changes later, stop the service and
repeat the reviewed generation/installation procedure.

Verify the **actual**, not inferred, state:

```sh
systemctl --user status gym-dev-hub-operator.service --no-pager
curl --fail http://127.0.0.1:3101/health/live
curl -I --fail http://127.0.0.1:3100/
journalctl --user -u gym-dev-hub-operator.service -n 30 --no-pager
```

Keep journal output private: it can contain diagnostics. A systemd
`active` status alone is **not** a passed HTTP/Docker acceptance
receipt. For an owner-controlled stop/disable:

```sh
systemctl --user stop gym-dev-hub-operator.service
systemctl --user disable gym-dev-hub-operator.service
```

## Login vs. boot

On the currently tested Linux Mint host, `loginctl show-user "$USER" -p Linger` reports **`Linger=no`**. A user service enabled under
`default.target` therefore starts **after that user's login** and may
stop on last logout; it does **not** guarantee boot-before-login
operation. Do not enable linger as part of PR #134. If boot-before-login
is genuinely required, evaluate and separately authorize the privileged
`sudo loginctl enable-linger "$USER"` change, along with a safe
startup policy for Docker daemon availability and secret access.

The user manager may have outdated group memberships after a user is
added to the Docker group; verify Docker access from that actual
session and re-login if necessary. Never use root Node, a remote
Docker daemon, `sudo pnpm` or `chmod 666 /var/run/docker.sock`.

## Acceptance boundary

Current PR validates **unit generation, static systemd syntax, rejection
tests and local read-only owner CLI**. It has **not** installed,
enabled, started, stopped or restarted a systemd service, nor performed
a reboot/login persistence test. A future owner-authorized service
handover can verify startup/stop/restart, HTTP 200/200, no duplicated
supervisor, exact Git SHA, Docker socket access and continued audit
history. The actual Issue #108 golden HTTP→Docker→Draft PR and CI
receipts are separate acceptance work.
