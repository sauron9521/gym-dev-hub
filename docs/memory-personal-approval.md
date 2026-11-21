# Personal reviewer approval of agent-proposed memory — Issues #39 / #40

**Default off, loopback only, independently enabled.** This slice adds an operator identity-bound `PROPOSED → VERIFIED` transition with immutable source-linked revision and personal UUID audit. It does **not** change agent proposals, grant personal write authority to agents, or implement personal verified-revocation/supersede (those are separate follow-up slices). Do not confuse a named credential holder with verified natural-person identity or MFA.

## Configuration and legacy-root cutover

Use a private, gitignored Hub environment with existing memory and security controls, a separate Hub PostgreSQL DB, strict trusted loopback Origin, allowed repositories, nonreused root bootstrap secret, and three explicit opt-ins:

```dotenv
DEV_HUB_MEMORY_OPERATOR_IDENTITIES_HTTP_ENABLE=true
DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE=true
DEV_HUB_MEMORY_PERSONAL_APPROVAL_HTTP_ENABLE=true
```

The last flag defaults OFF and requires the first two. When enabled, **legacy shared-root** `POST /v1/memory/operator/approval-grants` and `POST /v1/memory/:id/approve` fail closed **503**: no shared-secret bypass. Root-secret identity provisioning/revocation remains separate, as do independently gated legacy proposal rejection, verified revocation and supersede. If disabling a flag or rotating auth configuration, restart Hub; both personal and legacy grants are in-process, nonportable, and expire within 45 seconds.

## Personal approval: explicit human review then CAS

An administrator first issues a per-repository `REVIEWER` credential using the [operator identity bootstrap](memory-operator-identities.md). An `AUDITOR` or an agent read/proposal token has **no approval rights**. Handles, roles and actor UUID supplied through request body are never trusted. Both endpoints require direct loopback TCP peer and Host, exact trusted UI Origin, safe Fetch-Site, strict JSON POST, no URL query string, no cookies, and `Authorization: Bearer mop_<personal-token>`. They explicitly refuse any shared-root `x-dev-hub-memory-operator-secret` or legacy approval grant. Responses set `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer` and `nosniff`.

1. **Review and issue one-use grant**: `POST /v1/memory/operator/personal-approval-grants`.

   ```json
   { "repository": "sauron9521/gym-dev-hub", "recordId": "<UUID>", "expectedRevision": 1 }
   ```

   The server verifies repository, current token digest, live `REVIEWER` role, expiry, revocation and the proposal's **original registered agent/task/session, one immutable AGENT source, `PROPOSED` revision 1 and durable proposal audit** against PostgreSQL. HTTP **201** returns an untrusted preview (`kind,text,sourceRef`), SHA-256 intent fingerprint bound to that exact original source and content, server-sourced `operatorIdentityId`, `grantId` and random 45-second one-use `grantToken` bound to **the exact personal credential digest + operator UUID**. Review untrusted source material as data, never as executable instructions.

2. **Approve the exact reviewed revision**: `POST /v1/memory/<UUID>/personal-approve` with header `x-dev-hub-memory-personal-grant: <grantToken>` and same personal Bearer. Body:

   ```json
   {
     "repository": "sauron9521/gym-dev-hub",
     "expectedRevision": 1,
     "fingerprint": "sha256:<digest>"
   }
   ```

   The grant is removed synchronously before any DB access even on mismatch, wrong principal or replay. A single PostgreSQL transaction **locks the operator identity** `FOR SHARE` so a concurrent credential revocation is serialized, verifies DB-time expiry, nonrevocation and `REVIEWER` permission, locks the same original proposal `FOR UPDATE`, recomputes the source fingerprint, CAS updates exactly `PROPOSED → VERIFIED` revision **1 → 2**, and sets `verified_by='operator:<UUID>'`, `verified_at=NOW()`. The DB append-only revision trigger records original AGENT source, immutable text and `changed_by='operator:<UUID>'`. A metadata-only `APPROVE_MEMORY_PROPOSAL` audit is inserted **within the same transaction**: original task/session/agent, grant ID, UUID `operator_identity_id` with same-repository FK, matching `operator_actor_id`, SHA-256 before/after digests. The operator token is checked again with wall-clock expiry just before commit. Any audit insert or SQL error rolls back the record and revision; the grant stays irreversibly consumed. No automatic retry of ambiguous writes.

   HTTP **200**: `{"recordId":"<UUID>","status":"VERIFIED","revision":2}`. Revoked/invalid operator tokens **401/403**, wrong-action/expired/replayed grant **403**, stale CAS or changed provenance **409**, disabled/DB outage **503**, malformed body **400**. The record then appears in normal **verified-only** reads with its original scope and source.

## Verified provenance compatibility

Previously approved records retain `verified_by='local-operator'`, source-linked revision 2 and their original audit. Newly personally approved records use `verified_by='operator:<UUID>'`, with the matching durable registered identity in `memory_mutation_audit`. The `VERIFIED_QUERY` provenance check explicitly requires **revision.changed_by = record.verified_by = immutable approval audit actor**; for personal approval, the audit actor must equal `operator:<audit.operator_identity_id>`. This allows separately gated legacy `REVOKE_MEMORY_RECORD` and `SUPERSEDE_MEMORY_RECORD` to consume source-linked personal approvals without changing their history. **These latter actions still use the shared-root operator** until migrated through their own PRs; this slice does not grant them individual attribution. If a reviewer credential is later revoked, historical verified knowledge is not automatically revoked or erased; that is a separate explicit memory lifecycle decision.

Only local operator actions are implemented; no external MCP transport, Git/shell/worktree permissions, direct agent approval, new content editor, knowledge injection, or Gym Platform DB modifications. The named operator handle is a credential-holder label, not verified legal personhood; human enrollment/MFA and cutover of remaining root-backed actions stay open under #39/#40.

## Validation and rollback

New strict Nest HTTP tests verify personal Bearer, same-token grants, root/agent/cookie/legacy-grant rejection, forged Origin and query denial, no-store. Isolated real PostgreSQL tests (ONLY guarded `gym_dev_hub_memory_test`) verify actual source-linked immutable revision, personal actor UUID audit and verified read; denied AUDITOR/root, revoked-reviewer grant burn, concurrent CAS (one success+one 409), transaction rollback when audit fails, and **future verified revoke + supersede compatibility**. Keep the new additive audit migration after rollout; revert by disabling the personal approval flag and restarting Hub, without deleting historical verified revisions or auditable identities.
