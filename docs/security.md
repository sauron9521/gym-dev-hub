# Shared Agent Memory security primitives (Issue #39)

**Rollout status: security primitives ONLY. There are no enabled memory read or write routes.** `GET /v1/memory`, `/v1/memory/:id`, `/v1/memory/:id/revisions`, and `/v1/memory/status` **still return HTTP 503**. This PR does not register `MemoryAuthorizationService` as a Nest provider or connect its bearer helper to `MemoryQueryService`. No Codex agent, GitHub token, worktree grant, SSH key, localhost caller, iframe or MCP app receives new access by default. Existing `agent-workspace.json`, Web and Codex continue working with the previous local-only behavior. See [memory read design](memory-read-api.md) and [ADR](architecture/shared-agent-memory.md).

## Separate opt-in configuration

Every value below must be configured _privately_ inside gitignored `apps/api/.env` **only when actively testing this control plane**. Do not copy secrets into prompts, PRs, logs, screenshots or repo files. These flags alone **do not** enable HTTP memory routes or persistence.

```dotenv
DEV_HUB_MEMORY_ENABLE=true
DEV_HUB_MEMORY_SECURITY_ENABLE=true
DEV_HUB_MEMORY_OPERATOR_SECRET=<NEW-INDEPENDENT-RANDOM-SECRET-AT-LEAST-32-BYTES>
DEV_HUB_MEMORY_ALLOWED_REPOSITORIES=sauron9521/gym-dev-hub
DEV_HUB_MEMORY_TRUSTED_ORIGIN=http://127.0.0.1:3100
DEV_HUB_MEMORY_EXTERNAL_READ_ENABLE=false
```

Generate the operator secret locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Never reuse the worktree creation, task execution, Docker or GitHub token. `DEV_HUB_MEMORY_ALLOWED_REPOSITORIES` is a separate, exact `owner/name` list (maximum 16); **`GITHUB_REPOSITORIES` is not an authorization policy** and does not automatically grant rights. Only a literal `true` on both memory enable flags activates the _in-process primitives_. Invalid or missing secrets, invalid allowlist or non-loopback UI origin fails closed.

The memory control plane is **not ready for network exposure**. Both Next/Web and API must remain on loopback. A reverse proxy, SSH tunnel, Docker port publish, LAN address or CORS header is never authentication. Browser mutations require an exact trusted local `Origin` and allowed `Sec-Fetch-Site`; remote peer addresses, spoofed Host, cross-site origins and tokens placed in URL/query parameters fail closed. Future HTTP integration must still verify Bearer plus authenticated principal for each operation and prevent caching of secret-bearing responses. No cookie session is accepted here, so there is no implicit cookie-based CSRF authority.

## Identity & capabilities

| Identity                   | Credential                                                                                                      | Allowed operations                                                                                                       | Lifetime / revocation                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `operator`                 | Independent 32–256 byte secret, compared via constant-time SHA-256 digest                                       | Provision narrowly scoped **read-only** credentials; issue/revoke fixed-purpose one-use _approval grants_                | Never sent to agent prompt or stored in DB. Changing/invalidating configuration clears all credentials and grants |
| `agent`                    | One 32-byte random bearer issued only after explicit operator authentication, hashed in process memory          | `READ_VERIFIED` for exactly its trusted repository/task/session/agent scope; **no approve/write/shell/Git/merge/Docker** | Maximum 15 minutes; revoke by credential ID; restart invalidates                                                  |
| `external` MCP client      | Separate, explicitly provisioned random bearer; `DEV_HUB_MEMORY_EXTERNAL_READ_ENABLE=true` required in addition | `READ_VERIFIED` only; never operator approval, never remote network access granted by token alone                        | Maximum 5 minutes; revocable; no external HTTP/MCP endpoint yet                                                   |
| One-time operator approval | Fresh 32-byte random grant token bound to `repository + action + recordId + expectedRevision + fingerprint`     | Only `APPROVE_MEMORY_PROPOSAL` or `REVOKE_MEMORY_RECORD`; **this PR performs no DB mutation**                            | 45 seconds, single use, grant-ID revocation, wrong-context attempt consumes token, restart/rotation revokes       |

Credential and grant maps contain **only SHA-256 token hashes**, never raw bearer values. A token is shown once as the direct result of an explicit trusted operator action; it must not be logged or sent to Codex. Audit snapshots are bounded to 256 metadata-only events: type, fixed operator actor ID, allowed repository, generated resource ID and timestamp, never secret, token, arbitrary chat body, Git SHA from an unverified source or raw prompts. No file-based token store; restarting Nest revokes everything. Bad operator-secret attempts are limited to 12 per minute **per local process**; an eventual multi-instance auth deployment will require distributed rate limits and persistent revocation before the feature can be enabled remotely.

The initial pure primitives intentionally do **not** verify task/session/agent IDs against PostgreSQL, and operator credentials are not yet exposed through secure UI actions. Before wiring any endpoint, a separate reviewed integration must verify the typed identity row belongs to the exact allowed repository and task, create the trusted context **server-side** using the authenticated bearer (never caller-supplied query params), and enable database reads only after success. The existing read service's tenant predicate is necessary but not enough to prove authorization. A read-token alone can never create or approve a write grant.

## Error boundaries and review gates

`memory-http-identity.ts` provides an **unmounted** HTTP helper which accepts only a strict `Authorization: Bearer <43-character-token>` header after local network/Origin/Host checks and translates errors to **401** (missing/invalid credentials), **403** (forbidden scope or origin), **429** (rate limit), **503** (disabled/unavailable). No errors include raw secrets. Existing reserved HTTP routes still produce 503 regardless of headers, network origin or DB configuration. The helper does not grant authority merely because the process is bound to `127.0.0.1`.

Security acceptance tests in `apps/api/test/memory-authorization.spec.ts` and `memory-http-identity.spec.ts` cover secret separation, default deny, explicit allowlist, remote/CSRF/Origin/Host rejection, token-URL rejection, anonymous read, per-repo/task scope, external-client opt-in, wrong operator secret, expired/replayed/revoked grants, secret rotation, rate limits and audit confidentiality. `pnpm check` exercises these with **no PostgreSQL connection**. No migrations, credential persisted storage, model changes or CLI commands are introduced.

**Next gate:** wire a real authenticated repository principal + DB identity check to safe read routes in a separate small PR, with real Nest HTTP e2e tests and no mutation rights. Issue #40 then implements explicit human-reviewed approval and CAS/audit DB writes using the one-time grant interface after a separate review. Do not conflate an issued grant with approved/persisted memory; no provider or operation here can modify records. Rollback is disabling `DEV_HUB_MEMORY_SECURITY_ENABLE` (or deploying the prior version); no data migration or JSON changes required.
