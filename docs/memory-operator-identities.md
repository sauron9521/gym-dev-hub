# Individually scoped Hub operator credentials — Issue #39

This is the **first, default-off foundation PR** for individually scoped operator credential holders and role-based authorization. **It does not itself modify existing approve/reject/revoke/supersede endpoints.** A later [independent personal rejection cutover](memory-personal-rejection.md) can disable shared-root rejection and record a personal operator UUID, and [personal approval](memory-personal-approval.md) can separately disable shared-root approval and record a personal operator UUID; verified-revoke/supersede remain shared-root until separately migrated. Do not mistake a newly issued operator token for permission to mutate memory.

## Enable only on a trusted local machine

Keep the existing independent Hub memory enable flags, strict allowlist, dedicated **gym_dev_hub_memory** PostgreSQL connection, 32+ byte operator bootstrap root secret and exact trusted loopback UI Origin in private `apps/api/.env`. Enable the _additional_ independent flag only when managing operator credentials:

```dotenv
DEV_HUB_MEMORY_OPERATOR_IDENTITIES_HTTP_ENABLE=true
```

Unset/`false` returns **503** for all three identity endpoints. A wrong, missing or malformed flag fails closed; changing any memory security flag also invalidates process-local agent and approval grants. Operator identities, their hashed credentials and issuance/revocation audit survive API restart (in dedicated Hub PostgreSQL only). Nothing here grants Git, shell, worktree, Docker, GitHub or remote/MCP access.

All routes require **direct loopback TCP peer + loopback Host + exact trusted Origin + strict JSON Content-Type** and refuse query strings/cross-site Fetch metadata. Send secrets only in headers, never URLs, prompts, screenshots or source files; responses use `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer` and `nosniff`. This is not a browser cookie session.

## Bootstrap / revoke a named credential holder

Only the **existing root operator secret** in header `x-dev-hub-memory-operator-secret` may issue or revoke individuals. An agent Bearer, personal operator Bearer or reviewer role **cannot create or revoke identities**.

`POST /v1/memory/operator/identities`:

```json
{
  "repository": "sauron9521/gym-dev-hub",
  "handle": "alice_reviewer",
  "role": "REVIEWER",
  "ttlSeconds": 3600
}
```

`handle` is a strictly normalized 3–48 character lowercase local label (letter first, then letters, numbers, dash and underscore); it must be unique per repository, immutable and is **not** accepted as an identity claim from later API requests. Role is one of exactly:

- `AUDITOR` — may check only their credential/role metadata.
- `REVIEWER` — permitted to reject unverified proposals when [personal rejection](memory-personal-rejection.md) is enabled and to approve independently reviewed proposals when [personal approval](memory-personal-approval.md) is separately enabled; verified-revoke and supersede require future individually guarded cutovers.

TTL must be an integer **60–86400 seconds**. The server returns HTTP **201** with a new UUID `identityId`, handle, repository, role, expiry and **one-time** `bearerToken: "mop_<random-256-bit>"`. The raw token exists only in this response and is stored in the database as a SHA-256 digest with a domain-separation prefix. It cannot be recovered later. **Never paste it into ChatGPT or store in Git.** Handles cannot be reissued with a different role; a new identity needs a different handle. The database emits metadata-only immutable `ISSUED` event as part of the same transaction; failure rolls back registration.

`POST /v1/memory/operator/identities/<identity-UUID>/revoke` with the root-secret header and body `{"repository":"sauron9521/gym-dev-hub"}` permanently revokes an identity. Returns `{"revoked":true}` when changed, `false` when already revoked or absent. An immutable `REVOKED` event is inserted **atomically** if the status actually changes. There is no undelete, re-activate, in-place role escalation, expiration extension or token rotation in this slice.

## Personal token validation

`POST /v1/memory/operator/identities/whoami` with header `Authorization: Bearer mop_<token>`, JSON `{"repository":"sauron9521/gym-dev-hub"}`. Root operator secret header is explicitly denied on this route. On success (HTTP **200**) returns `identityId`, server-registered `handle`, exact `repository`, `role` and derived `permissions` — never the raw token or digest.

Internal `MemoryOperatorIdentityService.verify(token, repository, action)` verifies the random token, DB-registered role, exact repository membership, **DB-time expiry** and revocation on **every call**. There is no authorization trust in any actor/role from query/body, UI, source text or MCP. Invalid/revoked/expired tokens return **401**, valid `AUDITOR` for `APPROVE_MEMORY_PROPOSAL` etc. **403**, foreign repository **403**, disabled/not configured **503**, malformed request **400**, duplicate handle **409**, root-secret brute-force rate limiting inherited from existing memory operator authentication **429**.

Separate process instances share the same database revocation state, so revocation works after restart without a memory cache. Token secrets, raw prompts, payloads, DB URLs, cookies and auth headers are excluded from immutable metadata-only audit. A PostgreSQL trigger forbids modifying/re-activating identity fields or deleting records/audit events. Strict `(repository,operatorId)` foreign keys protect audit attribution from cross-repository substitution.

## Security boundaries and next PR

The present bootstrap root secret is a shared **administrator credential**. A named `handle` proves only **possession of that holder's separate token**, not verified individual human identity. It does not provide MFA, passkeys, proof-of-person enrollment, nonrepudiation or guarantee a human hasn't shared a token. For truly attributable human decisions, future reviewed slices must bind individual operator authorization and role to **every remaining** operator action. [Personal rejection](memory-personal-rejection.md) now binds operator UUID in its immutable audit/revision and disables old root rejection when opted in; [personal approval](memory-personal-approval.md) also records immutable operator UUID when separately enabled; verified-revoke and supersede still require their own cutovers, and optionally add passkeys/MFA or organizational enrollment/identity verification. Do **not** mark Issues #39 or #40 complete until that is proven through negative and real PostgreSQL tests.

Validation is intentionally limited to a dedicated local Hub DB and isolated `gym_dev_hub_memory_test` CI; it cannot access Gym Platform's database or APIs. Run only `pnpm check` locally; GitHub's opt-in Memory PostgreSQL workflow runs independent test-DB migration/credential issuance, role refusal, revocation across service instances, TTL, audit rollback and immutability tests.

Rollback is disabling the independent flag and restarting the Hub. Keep the additive database tables and immutable audit; do not drop migrations or wipe the operator registry during normal rollback.
