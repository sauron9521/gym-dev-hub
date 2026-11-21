# Operator-reviewed memory supersession — Issue #40

**Default OFF; only local operator actions.** This route atomically moves a **previously VERIFIED** session-scoped memory record at revision **2** to terminal `SUPERSEDED` revision **3**, pointing to a **different, independently VERIFIED** memory record. It does **not** auto-approve an agent proposal, edit text, change scope, delete history, or expose Codex/MCP writes.

## Enable the independent, narrow capability

In the Hub API's private gitignored environment, alongside existing memory+security enablement, dedicated Hub DB, operator secret, allowlisted repositories, and loopback trusted Origin:

```dotenv
DEV_HUB_MEMORY_SUPERSEDE_HTTP_ENABLE=true
```

Unset or `false` returns **503** from both routes; other read/propose/approve/reject/revoke flags are independent. Any memory-security flag change invalidates process-local credentials/grants. This is NOT a remote control API: the HTTP peer, Host, exact trusted Origin, Fetch-Site, strict JSON content type, and query-string exclusion are enforced on both routes. Bearer tokens (including agent proposals and read-only) are forbidden here. Operator secrets or grants must never be passed in URLs, logs, prompts or Git.

## Requirements for old and new records

Both records must already be `VERIFIED`, exactly revision 2 from independent explicit approvals with recorded `PROPOSED` revision 1, AGENT source, registered same-repository task/agent/session, and immutable proposal+approval audit events. Their **repository, scope = SESSION, task ID, session ID, agent ID and kind must match**. The new record must have its **own distinct source evidence and approved content**; no copied or fabricated source is accepted as part of this operation. Both records must be unexpired and their supersession pointers must be empty. Only one predecessor may point to any replacement (unique partial index); chains of already approved replacements are possible, not branches or cycles. Historical private text and ownership remain immutable.

The sourceRef shown in review is **untrusted agent-provided provenance**, not independent proof of external truth. The human operator must evaluate both previews and underlying evidence before issuing the second request.

## Two explicit actions

1. Review the pair (with `x-dev-hub-memory-operator-secret` and exact trusted Origin):

   `POST /v1/memory/operator/supersede-grants`

   JSON body:

   ```json
   {
     "repository": "sauron9521/gym-dev-hub",
     "recordId": "OLD_UUID",
     "replacementRecordId": "NEW_UUID",
     "expectedRevision": 2
   }
   ```

   The server re-reads both approved sources, versions and identity relationships. HTTP **201**, no-store, returns `preview.original` and `preview.replacement` (untrusted `kind,text,sourceRef`), `fingerprint` computed over **both** distinct UUIDs, source-linked current snapshots, status/revisions and expiration, and a 45-second one-use, revocable `SUPERSEDE_MEMORY_RECORD` `grantToken` and `grantId`. An approval, rejection or revocation grant cannot be used for supersede.

2. After deliberate review, explicitly commit the single pair:

   `POST /v1/memory/<OLD_UUID>/supersede`

   Headers: same operator-secret and `x-dev-hub-memory-approval-grant: <grantToken>`; body:

   ```json
   {
     "repository": "sauron9521/gym-dev-hub",
     "replacementRecordId": "NEW_UUID",
     "expectedRevision": 2,
     "fingerprint": "sha256:<digest>"
   }
   ```

   The grant is **consumed synchronously before database work**. A PostgreSQL transaction locks both old and replacement records in deterministic UUID order, rechecks independently approved revisions, original sources and matching scope/owner/type, recomputes the pair fingerprint, ensures the replacement has no prior predecessor, then conditionally updates the old record with `WHERE status='VERIFIED' AND revision=2 AND superseded_by_id IS NULL`. An immutable source-linked `SUPERSEDED` revision 3 and metadata-only audit `SUPERSEDE_MEMORY_RECORD` (operator label, unique grant ID, SHA-256 before/after digests, old agent/task/session) are committed **atomically** with the new `superseded_by_id` link. The replacement remains `VERIFIED`, revision 2, unchanged. The read API no longer returns the old record.

   Success **200**: `{"recordId":"OLD_UUID","status":"SUPERSEDED","revision":3,"supersededById":"NEW_UUID"}`. Competing writes or mismatched pair/scope return **409**, replayed/wrong-action/revoked grants **403**, invalid body **400**, disabled flag/DB failures **503**. A database or audit error **rolls back** link, status, revision and audit; the one-use grant is still consumed. Never automatically retry a write after an ambiguous/lost response; inspect the latest records read-only.

## Database protections and remaining work

The additive Prisma migration extends the immutable audit action allowlist, enforces one predecessor per replacement with a unique index, requires a transaction-local operator action and verified matching-owner target for any `VERIFIED → SUPERSEDED` change, and makes `SUPERSEDED` terminal. It preserves `REVOKED` terminal and existing reject/revoke behavior. Triggers are **defense in depth**, not a substitute for isolated DB roles. No general version editor or remote/MCP/agent approval route is introduced. The audit does not store proposal text, raw prompts, tokens, secrets, or raw sources.

Real PostgreSQL integration tests run against **gym_dev_hub_memory_test only** in the opt-in Memory PostgreSQL workflow: three immutable source-linked revisions, durable audit, one-to-one link under concurrent supersedes, verified-read visibility, scope/type and self-link refusal, direct unaudited SQL refusal, grant replay, and audit-induced transaction rollback.

Still open in Issues #40 and #39: individually authenticated human operators and RBAC (current `local-operator` is a **shared-secret actor label**), external provenance trust checks, distributed grant control and final adversarial acceptance. Roll back by disabling the independent flag and restarting Hub; retain the applied additive migration and immutable audit/history.
