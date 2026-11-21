# Operator-reviewed Memory approval — Issue #40 (CAS slice)

**Default off. No agent approval.** This slice adds only an explicit local operator transition from a **DB-registered, immutable, session-bound, sourced** `PROPOSED` record to `VERIFIED`. The original agent proposal is untrusted data until this manual review. No automatic Codex context injection, general editor, UI or MCP transport is introduced. [Independently gated operator supersession](memory-supersede.md) can link two already verified same-owner records but cannot approve new proposals. A [separate revocation workflow](memory-verified-revocation.md) can withdraw a verified revision 2 only after independent operator review. Rejection of an unverified proposal is now separately gated and documented in [operator rejection](memory-rejection.md).

## Enable and isolate

Only on a loopback-only Hub API with the dedicated `gym_dev_hub_memory` database and existing independent memory+security configuration, set in the private gitignored `apps/api/.env`:

```dotenv
DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE=true
```

The **approval flag is independent** of `DEV_HUB_MEMORY_READ_HTTP_ENABLE` and `DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE`: disabling approvals leaves other explicitly enabled operations unchanged. If unset or false, both new endpoints return **503**. The secret must be the existing independent `DEV_HUB_MEMORY_OPERATOR_SECRET` (32–256 bytes, never shared with an agent). Neither agent read Bearer nor proposal Bearer can approve; the operator endpoint refuses **any Authorization bearer**.

This is a local single-process control plane, not a network/public REST API. Both requests must be a direct loopback peer with a loopback Host and exact configured trusted `Origin` header, JSON Content-Type, no query string, and no cross-site Fetch metadata. Never put secret or grant tokens in URLs, browser storage, Git, logs, screenshots or prompts.

## Required operator review then one-use approval

1. Explicit trusted operator action:

   `POST /v1/memory/operator/approval-grants` with `x-dev-hub-memory-operator-secret` header and JSON body

   ```json
   { "repository": "sauron9521/gym-dev-hub", "recordId": "UUID", "expectedRevision": 1 }
   ```

   Response HTTP **201**, `no-store`: the exact **untrusted** preview `{kind,text,sourceRef}`, repository, record ID, revision, `fingerprint: sha256:<digest>`, `grantId`, one-time `grantToken` and `expiresAt`. The server computes the fingerprint from the repository, original principal ownership, status, revision, text, kind and immutable AGENT source; clients cannot choose or bypass that fingerprint. Approvals are available only for fully sourced session-bound records inserted by the protected proposal API, with matching immutable initial revision, registered agent/task/session and proposal audit.

2. **After reviewing the preview and source evidence**, explicitly post

   `POST /v1/memory/<record-UUID>/approve` with the same operator-secret header, `x-dev-hub-memory-approval-grant: <grantToken>` and JSON

   ```json
   {
     "repository": "sauron9521/gym-dev-hub",
     "expectedRevision": 1,
     "fingerprint": "sha256:<digest>"
   }
   ```

   A consumed grant is irrevocably invalidated **before** any async DB work. Grants are intent-bound to record, repository, revision, fingerprint and `APPROVE_MEMORY_PROPOSAL`, expire in 45 seconds, and can be revoked. Wrong intent/replayed/expired grants fail **403**. The request holds a row lock, rechecks the registered source + source-linked revision and full fingerprint, then atomically applies `UPDATE ... WHERE status=PROPOSED AND revision=expectedRevision RETURNING ...`. Success is HTTP **200** `{recordId,status:"VERIFIED",revision:2}`. Missing/mismatched review, already verified/revised record or losing parallel approval returns **409**, no overwrite or implicit retry. If a response is lost, **inspect the record read-only**; do not automatically repeat the write.

## Database invariants

An additive Prisma migration locks original repository, scope, kind, task ID, session ID, agent ID, text and source SHA against all later revisions, preventing cross-tenant/history disclosure via ownership mutation. PostgreSQL's existing source-linked immutable revision trigger inserts revision **2** for the approved state. In the **same** transaction, metadata-only immutable `memory_mutation_audit` appends the exact original session-bound agent/task, constant `local-operator` actor label, one-use `grantId` (unique), action, SHA-256 `previous_digest` of the reviewed record+source and SHA-256 `resulting_digest` of the approval state/revision/verification time. Failed audit INSERT rolls back both record status and revision. Grant consumption cannot be undone by DB rollback. Source text, bearer tokens, operator secrets and raw prompts are **never stored in audit**.

`verified_by='local-operator'` is **single-operator shared-secret attribution, not proven per-human identity**. A trusted human must keep the operator secret off agent machines and explicitly review evidence; this API cannot independently prove that a particular person reviewed it. Implement per-human, durable operator authentication and fine-grained roles in a separately reviewed slice before team-wide or network access.

## Validation and remaining Issue #40 work

Local full `pnpm check` covers Nest HTTP, grant authenticity, origin/secret denial and capability separation, using no local PostgreSQL. The isolated GitHub **Memory PostgreSQL** workflow runs migration and real transaction tests against **gym_dev_hub_memory_test** only: two independent simultaneous approval grants → one success + one **409**, exact two source-linked revisions, transactional audit, immutable scope/text, grant replay/revocation, invalid source and rollback after deliberate audit failure.

**Still not done:** per-human operator identity and broader state-machine acceptance; [verified supersession](memory-supersede.md) is separately implemented for source-linked same-owner revision-2 records; [first-generation verified revocation](memory-verified-revocation.md) is separately implemented; unverified proposal rejection is [separately implemented](memory-rejection.md); durable unique human identity and RBAC, support for multiple Hub instances, independent source verification beyond an operator's manual evidence review, and broader integration tests/security acceptance before closing #40/#39. Existing `PROPOSED` records never appear in normal verified read results until successfully approved.

**Rollback:** disable `DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE` and restart the Hub process to invalidate outstanding in-memory grants. Keep the additive audit columns and all immutable history; do not drop migrations for routine rollback.
