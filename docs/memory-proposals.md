# Shared Agent Memory — proposal-only intake (Issue #40, first slice)

**Default off.** This page describes only the agent's _proposed/untrusted_ memory intake. A separate operator-only CAS approval workflow can now be opted in independently; see [operator-reviewed approval](memory-approval.md). It adds no automatic approval, context injection or MCP access. Existing read endpoints keep their independent `DEV_HUB_MEMORY_READ_HTTP_ENABLE` flag and only expose **VERIFIED** records. Gym Platform is not involved.

## Separate opt-in and authorization

In gitignored `apps/api/.env` on a **local-loopback-only** Hub instance, set the existing independent memory DB/security/Origin/operator-secret/repository allowlist variables, and separately set:

```dotenv
DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE=true
```

Leaving the variable unset or `false` returns **503**. Setting it to anything other than literal `true` or `false` disables memory security. Disabling or changing the flag invalidates all process-local bearer credentials.

A trusted local **operator** invokes the existing `POST /v1/memory/operator/credentials` with a strict JSON body naming an already-registered `repository`, `agentId`, `taskId`, `sessionId`, `ttlSeconds` and **`"permission":"PROPOSE_MEMORY"`**. Task, session and agent must belong to the exact same repository, and the session must match the task/agent pair in the dedicated Hub PostgreSQL. The operator's independent secret is required for issuance and is **never given to the agent**. The returned short-lived, revocable token has only `PROPOSE_MEMORY` capability; it cannot be used with existing read GET endpoints or operator approval functions. Earlier `READ_VERIFIED` tokens remain read-only and cannot submit proposals. External/MCP tokens cannot propose.

## HTTP request

`POST /v1/memory/proposals` is a direct loopback-only endpoint. Send `Authorization: Bearer <operator-issued-PROPOSE_MEMORY-token>`, an exact trusted `Origin`, `Content-Type: application/json`, and a **new UUID** in the `Idempotency-Key` header. Never send secrets in the URL, browser cookies, Git logs, prompts or telemetry. No UI or agent integration is automatic.

Body (strictly limited to these fields):

```json
{
  "kind": "decision",
  "text": "Suggested architecture fact for human review",
  "sourceRef": "agent-session:local-evidence-reference"
}
```

Only `fact`, `decision` and `constraint` kinds are accepted. The request cannot specify or spoof repository, task, session, agent, scope, status, approval, revision, timestamps or source actor; the server derives all identity and provenance fields from the authenticated DB-verified principal. `sourceRef` is a bounded **untrusted reference**, not verified source evidence; agent content is _data_, never runtime instructions. Obvious private-key, credential and token material in the text/source is rejected. This is a basic guard, **not** a comprehensive secret classifier or replacement for operator review.

Successful HTTP **201** replies contain only `{ "recordId": "UUID", "status": "PROPOSED", "revision": 1, "replayed": false }` with `Cache-Control: no-store`. Retrying the same key with the identical payload returns the original ID and `replayed: true`; using the same key with a different payload returns **409** without modifying the earlier proposal. The key is scoped by actual repository/agent/session. Missing/malformed input or detected secrets give **400**, invalid Bearer **401**, wrong capability/Origin/scope **403**, disabled feature or DB outage **503**. No raw SQL errors or secrets are included in responses.

## Transactional persistence and rollback

A single local PostgreSQL transaction validates the scoped principal again, serializes the idempotency key with a transaction advisory lock, writes `memory_records` as `SESSION/PROPOSED`, links an immutable `AGENT` source, creates the first source-linked immutable revision via the database trigger, inserts the unique idempotency key and writes metadata-only `memory_mutation_audit` (agent/task/session, before/after SHA-256 digest, fixed operation, time). The initial revision source foreign key is deferred **only to the end of the transaction**, not omitted. Any failed step rolls back every mutation, including the revision. Concurrent identical retries have exactly one creator; changed-content collisions fail 409. Historical rows and audit cannot be updated or deleted.

This proposal intake **never** approves, rejects, supersedes or modifies records. A separate operator-only [approval slice](memory-approval.md) now implements explicit grant consumption and CAS `expectedRevision=1` to `VERIFIED` with durable approval metadata and immutable ownership. Unverified proposal rejection now exists behind a separate operator-only flag (see [rejection](memory-rejection.md)); per-human operator identity, independently verified source trust and verified-record revocation of revision 2 is independently implemented (see [revocation](memory-verified-revocation.md)), while supersede rules remain outstanding in #40. Keep Issues #40 and #39 open until their actual criteria are fulfilled.

## Validation

`pnpm check` covers auth and real Nest HTTP negative tests without a DB. The opt-in **Memory PostgreSQL** GitHub workflow applies the new dedicated migration to **gym_dev_hub_memory_test** only, runs actual SQL transactions, concurrent identical key retries, 409 conflicts, immutable source/revision/audit assertions, rollback on forced audit failure, failed session identity and confirmed exclusion of `PROPOSED` from verified read queries. Do not test against the dev or production DB.
