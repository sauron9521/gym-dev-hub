# Individual reviewer-bound memory proposal rejection — Issue #39 / #40

This independently gated, local-only security slice moves **only** unverified proposal rejection to a database-verified, repository-scoped `REVIEWER` identity. Unlike the older shared-root rejection path, each durable rejection audit explicitly attributes the decision to the **server-derived operator UUID**. It does not yet migrate approval, revocation of verified memory, or supersession.

## Required opt-ins, default OFF

The dedicated Hub API must already have memory, security and the independent proposal/rejection/identity capabilities deliberately enabled. In a private environment (never checked into Git), opt into the additional flag:

```dotenv
DEV_HUB_MEMORY_PERSONAL_REJECTION_HTTP_ENABLE=true
```

This separate flag requires `DEV_HUB_MEMORY_OPERATOR_IDENTITIES_HTTP_ENABLE=true` and `DEV_HUB_MEMORY_REJECTION_HTTP_ENABLE=true`. When **true**, the **legacy shared-root rejection-grant endpoint and old `POST /v1/memory/:id/reject` return 503**; they cannot be used as an operator-role bypass. Existing approve, verified-revoke, supersede and agent proposal/read flows remain governed by their own independent flags, unchanged. Disabled/misconfigured identity checks fail closed. If changing flags or rotating secrets, restart the Hub so no in-process short-lived grants survive.

The approved holder must already have a `REVIEWER` credential issued via the [independent root-only operator identity bootstrap](memory-operator-identities.md). An `AUDITOR` cannot perform rejection. `handle` and `operatorId` are never accepted from client body, URL, Origin or agent-provided text.

## Deliberate two-step, per-operator review

Both new endpoints are restricted to **direct loopback socket, loopback Host, exact trusted UI Origin, safe Fetch-Site and strict JSON POST**, without URL query strings/cookies. They **reject** the shared `x-dev-hub-memory-operator-secret`, old `x-dev-hub-memory-approval-grant`, and agent READ/PROPOSE Bearers. Use `Authorization: Bearer mop_<personal-token>` in the header, never in URLs, logs, chats, file attachments, prompts or Git.

1. **Review untrusted proposal and obtain intent-bound personal grant**:

   `POST /v1/memory/operator/personal-rejection-grants`

   Body `{"repository":"sauron9521/gym-dev-hub","recordId":"<proposal-UUID>","expectedRevision":1}`.

   The server checks **current operator identity + role + expiry + revocation against PostgreSQL on every review**, then verifies original registered agent/task/session, proposal source/ref, initial immutable revision and initial audit; it returns HTTP 201, `Cache-Control: no-store`, untrusted review preview, server-computed `sha256:<fingerprint>`, an opaque 45-second, one-use `grantToken` and `grantId` bound to **that exact personal token digest and operator UUID**. No raw secret/token is stored in PostgreSQL mutation audit. The token is kept only in a bounded, process-local keyed-grant map and cannot be redeemed on another process: that fails closed.

2. **Commit rejection after explicit review**:

   `POST /v1/memory/<proposal-UUID>/personal-reject`

   Headers: same `Authorization: Bearer mop_<token>`, plus `x-dev-hub-memory-personal-grant: <grantToken>`. Body `{"repository":"sauron9521/gym-dev-hub","expectedRevision":1,"fingerprint":"sha256:<digest>"}`.

   The grant is consumed **synchronously, before any DB operation**, even on wrong bearer or mismatch; it can never be replayed or silently retried. In **one PostgreSQL transaction** the server **locks the personal identity row `FOR SHARE`**, rechecks repository, token digest, live `REVIEWER` role and **DB-time expiry/revocation** (an in-flight revoke waits; a revoke committed first blocks this write), locks the same proposal row, validates the original untrusted source, status, CAS revision and fingerprint, then transitions exactly `PROPOSED → REVOKED` revision **1→2**. It commits with the immutable source-linked revision, `changed_by='operator:<UUID>'`, and a metadata-only `REJECT_MEMORY_PROPOSAL` audit row carrying **`operator_identity_id=<UUID>`**, `operator_actor_id='operator:<UUID>'`, exact repository, original agent/task/session, one-use grant ID and before/after SHA-256 digests. The audit's composite foreign key `(repository,operator_identity_id)` references the registered operator identity; the append-only DB audit constraint enforces the actor/UUID relationship. The rejected proposal disappears from all verified-only reads.

   Success HTTP **200**: `{"recordId":"<UUID>","status":"REVOKED","revision":2}`. Expired/invalid personal token **401**, valid `AUDITOR` for reviewer action **403**, wrong or replayed grant **403**, conflict/racing CAS or changed source **409**, malformed JSON/schema **400**, disabled/DB failures **503**. Audit failure rolls back status, revision and audit in the same DB transaction; grant remains consumed. **Never automatically retry a lost/ambiguous write response**: reconcile via reads.

## No privileges outside this slice

This adds no ability for an agent to approve, edit, reject or grant itself operator rights. The named handle is a **credential-holder label**, not proof that a uniquely identified natural person performed the action. It is not MFA, passkey authentication, or verified identity enrollment. The shared bootstrap root secret still manages operator credentials and still controls **other** operator decision flows until separately migrated; do not claim a global cutover or close #39/#40 yet.

An opt-in flag can be disabled for rollback; doing so must **not** delete the additive migration or immutable audit. The independent Hub PostgreSQL database is restricted to loopback and is not Gym Platform's database. Real DB tests use ONLY `gym_dev_hub_memory_test`, guarded by CI, covering operator role, revocation before commit, competing personal grants, immutable source-linked history, cross-principal replay, no raw secret logging and audit failure rollback.
