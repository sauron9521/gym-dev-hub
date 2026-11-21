-- Safe, independently gated operator UUID for PROPOSED -> REVOKED only.
-- Existing legacy APPROVE / REJECT / REVOKE / SUPERSEDE audits remain intact.
ALTER TABLE memory_mutation_audit
  ADD COLUMN operator_identity_id UUID;

ALTER TABLE memory_mutation_audit
  ADD CONSTRAINT memory_mutation_audit_operator_identity_fk
  FOREIGN KEY (repository,operator_identity_id)
  REFERENCES memory_operator_identities(repository,id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE memory_mutation_audit DROP CONSTRAINT memory_mutation_audit_action_ck;
ALTER TABLE memory_mutation_audit ADD CONSTRAINT memory_mutation_audit_action_ck CHECK (
  (action = 'PROPOSE_MEMORY' AND operator_actor_id IS NULL
    AND operator_identity_id IS NULL
    AND grant_id IS NULL AND previous_digest IS NULL)
  OR
  (action IN ('APPROVE_MEMORY_PROPOSAL','REJECT_MEMORY_PROPOSAL',
     'REVOKE_MEMORY_RECORD','SUPERSEDE_MEMORY_RECORD')
    AND operator_actor_id = 'local-operator'
    AND operator_identity_id IS NULL
    AND grant_id IS NOT NULL AND previous_digest IS NOT NULL)
  OR
  (action = 'REJECT_MEMORY_PROPOSAL'
    AND operator_identity_id IS NOT NULL
    AND operator_actor_id = 'operator:' || operator_identity_id::text
    AND grant_id IS NOT NULL AND previous_digest IS NOT NULL)
);

CREATE INDEX memory_mutation_audit_personal_actor_idx
  ON memory_mutation_audit(repository,operator_identity_id,created_at)
  WHERE operator_identity_id IS NOT NULL;
