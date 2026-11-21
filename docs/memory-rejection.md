# Operator-reviewed rejection of unverified memory (Issue #40)

**Default off; local-only, one decision per record.** This independently gated path allows a trusted local operator to reject a previously created `PROPOSED` agent record, moving it to terminal `REVOKED` with revision 2. This proposal-rejection route does **not** revoke `VERIFIED` knowledge; that separate operator workflow is documented in [verified revocation](memory-verified-revocation.md). Neither rejection nor verified revocation edits content or changes the supersession link; a [distinct operator-only supersede workflow](memory-supersede.md) manages that link. None deletes audit, injects Codex instructions or exposes external MCP/HTTP. A rejected record is never visible to the default verified-only memory read API.

## Explicit separate opt-in

Set `DEV_HUB_MEMORY_REJECTION_HTTP_ENABLE=true` only in the private Hub API environment on a loopback-only machine, alongside the existing memory/security, allowlist, dedicated Hub DB and trusted-Origin configuration. It does **not** require the approval HTTP flag to be enabled. Leaving the rejection flag unset or `false` makes both rejection endpoints return **503**. Changing this or any other memory security flag revokes all process-local credentials and grants.

The operator secret is `x-dev-hub-memory-operator-secret` on both requests; it is distinct from read/proposal Bearer tokens, which are **never** accepted on operator routes. Send strict JSON and exact trusted local `Origin`; the socket peer, Host, Fetch-Site and URL are also checked. Never send tokens/secrets in URLs or store them in chat, prompts or Git.

## Two deliberate operator actions

1. **Review an unverified proposal and its provenance**, then explicitly request a rejection grant:

   `POST /v1/memory/operator/rejection-grants`

   JSON `{"repository":"sauron9521/gym-dev-hub","recordId":"<UUID>","expectedRevision":1}`

   Server validates existing registered same-repo agent/task/session, immutable first revision, exact AGENT source and original proposal/audit. It returns HTTP **201**, `Cache-Control: no-store`, the **untrusted** `preview` containing kind/text/sourceRef, a server-computed `sha256:` fingerprint, `action:"REJECT_MEMORY_PROPOSAL"`, and a short-lived 45-second one-use `grantToken` with its `grantId`. Review the actual text and source; do not assume the agent-provided source reference is independently verified.

2. **Explicitly reject** only after review:

   `POST /v1/memory/<record-UUID>/reject`

   Header `x-dev-hub-memory-approval-grant: <grantToken>`, same operator secret, JSON `{"repository":"sauron9521/gym-dev-hub","expectedRevision":1,"fingerprint":"sha256:<digest>"}`.

   The reject route consumes the **REJECT-specific** grant synchronously before any database operation. An `APPROVE_MEMORY_PROPOSAL` grant cannot reject, and a rejection grant cannot approve; even an incorrect action attempt burns the grant. In one PostgreSQL transaction a row lock and CAS revalidate the record, original source and fingerprint, set `status='REVOKED'`, advance revision **1 → 2**, preserve original text/scope/agent/task/session, insert the immutable source-linked revision and persist metadata-only audit `REJECT_MEMORY_PROPOSAL` with unique grant ID, operator label `local-operator` and before/after SHA-256 digests. Success HTTP **200** `{"recordId":"<UUID>","status":"REVOKED","revision":2}`. A second concurrent rejection, competing approval or stale review returns **409** without overwriting the first decision; a repeated or wrong grant gives **403**. Any audit/DB failure **rolls back** status, revision and audit together, and the one-use grant remains consumed.

## Security and limitations

- Rejected records are terminal by the immutable record guard. They cannot later become verified, nor can their ownership, source, scope or text be changed.
- Direct SQL `PROPOSED → REVOKED` without the transaction-local operator action is rejected at the database trigger; this is a defense-in-depth invariant and **not** a replacement for DB role separation.
- Audit contains **no proposal text, token, operator secret or source payload**. Its `local-operator` actor label proves only the trusted local operator credential was used, not the identity of a unique human.
- The rejection flag is separate from approval; disabling it must not disable previously opted-in read or approve routes. Roll back by disabling the flag and restarting the Hub. Keep the additive migration and immutable history.
- No automatic retry after a lost response. Inspect the record and audit before deciding on any further action; do not create another grant blindly.

**Acceptance remaining (#40 and #39 stay open):** revocation of first-generation verified records is [separately available](memory-verified-revocation.md); supersede with revision-safe provenance, per-human operator identity/RBAC, independent source trust verification, durable distributed grants if the Hub ever runs across multiple instances, and final adversarial security review. PR #99 has been merged into `main`; all future changes use a fresh base.
