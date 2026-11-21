# Operator-only verified memory revocation (Issue #40)

**Default OFF; local machine only.** This operation withdraws a first-generation, previously verified, source-linked memory record so it can no longer appear in `READ_VERIFIED` responses. It is a separate, manual operator decision. No agent, read/proposal Bearer, external/MCP actor or Codex context may request it. It neither deletes nor edits the record, and it does not implement supersede.

## Activation and scope

In the Hub API's private, gitignored environment, keep the existing independent memory/security controls, explicitly permitted repositories, dedicated Hub PostgreSQL URL, trusted loopback Origin and independent operator secret. Activate only:

```dotenv
DEV_HUB_MEMORY_VERIFIED_REVOCATION_HTTP_ENABLE=true
```

Absent or `false` returns **503** on both new endpoints. The value must be exactly `true` or `false`. This flag is independent of `DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE` and the `PROPOSED` rejection flag. Changes to any memory security flag invalidate in-memory grants and credentials. Do not publish the API behind a remote reverse proxy.

This first slice supports **only** `VERIFIED` records at `expectedRevision:2` created through the session-bound `PROPOSE_MEMORY → APPROVE_MEMORY_PROPOSAL` workflow. A record must have exactly one immutable AGENT source, a source-linked initial `PROPOSED` revision, a source-linked `VERIFIED` revision, the registered original agent/task/session, proposal audit, approval audit, `verified_by='local-operator'` and a verification time. Preexisting externally inserted or more complex/versioned records are deliberately ineligible until a separate security review.

## Two explicit operator actions

1. Review the currently verified record and obtain a **45-second, one-use `REVOKE_MEMORY_RECORD` grant**:

   `POST /v1/memory/operator/revocation-grants`

   Headers: `x-dev-hub-memory-operator-secret: <secret>`, `Origin: <trusted-loopback-origin>`, `Content-Type: application/json`. JSON:

   ```json
   { "repository": "sauron9521/gym-dev-hub", "recordId": "UUID", "expectedRevision": 2 }
   ```

   HTTP 201 response contains a **no-store** review preview of the record's original text, kind and sourceRef, server-computed fingerprint covering repository, record, scope, full source/agent/task/session, status/revision, verifier and verification time; a one-use `grantToken`, `grantId`, action and expiration. Preview text and sourceRef are **untrusted data**, not instructions; operator should independently inspect source evidence.

2. After deliberate review, consume the specific revoke grant:

   `POST /v1/memory/<record-UUID>/revoke`

   Same operator-secret header, plus `x-dev-hub-memory-approval-grant: <grantToken>`. Body:

   ```json
   {
     "repository": "sauron9521/gym-dev-hub",
     "expectedRevision": 2,
     "fingerprint": "sha256:<digest>"
   }
   ```

   The grant is consumed synchronously before PostgreSQL work and cannot be reused or substituted for an approval/rejection grant. Inside a single transaction, the service locks the exact sourced record, re-verifies its two immutable revisions and original approval audit, recomputes the fingerprint, and performs CAS `WHERE status='VERIFIED' AND revision=2`. The record transitions to terminal `REVOKED` revision **3**, retains its original verified_by/verified_at (historical evidence), original text/ownership/scope and source, and adds immutable revision 3 and metadata-only `REVOKE_MEMORY_RECORD` audit, including `local-operator`, unique grant ID and before/after SHA-256 digests. These all commit or all roll back.

   Success HTTP 200: `{"recordId":"UUID","status":"REVOKED","revision":3}`. Competing revocations yield exactly one success and one **409**. Missing/stale/changed revisions are **409**; wrong/replayed/expired grants are **403**, invalid bodies **400**, missing operator secret **401**, disabled flag/DB errors **503**. No raw SQL errors or secrets are returned. A failed audit insert rolls back status and revision, while the in-memory grant remains irreversibly consumed. **Never automatically retry** a lost/ambiguous write response: reconcile read-only.

## Database defenses and caveats

The additive Prisma migration admits only operator-action `REVOKE_MEMORY_RECORD` audit with previous/resulting SHA-256 digests and unique grant ID. The immutable record trigger rejects `VERIFIED → REVOKED` without the transaction-local operator action, refuses changes to the original verification metadata, and forbids other status changes from `VERIFIED` by raw SQL; terminal `REVOKED` cannot be edited. These triggers are defense in depth, **not** independent DB-role isolation. No automatic deletion, general `PATCH`, undo or external transport. [Independently gated supersession](memory-supersede.md) is now permitted only for two separately verified records with identical ownership.

Full SQL integration runs only against the guarded `gym_dev_hub_memory_test`: immediate verified-read invisibility after revocation, three source-linked immutable revisions, three audit rows, parallel CAS, direct bypass refusal, rollback upon forced audit failure, and one-use replay denial. Keep Issue #40 open for human-specific operator identity/RBAC and independent source trust/security review; [verified supersession](memory-supersede.md) is now a separate opt-in. The shared-secret actor label `local-operator` does **not** prove a unique person's identity.

**Rollback:** turn the independent revocation flag off and restart Hub. Existing immutable rows and audit must remain; do not roll back data migration or erase history. No Gym Platform database or services are affected.
