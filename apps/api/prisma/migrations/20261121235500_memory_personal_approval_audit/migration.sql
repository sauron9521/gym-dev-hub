-- Personal operator approval uses the same immutable UUID-backed attribution
-- as personal rejection. Preserve legacy root-admin data and proposal-only audit.
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
  (action IN ('REJECT_MEMORY_PROPOSAL','APPROVE_MEMORY_PROPOSAL')
    AND operator_identity_id IS NOT NULL
    AND operator_actor_id = 'operator:' || operator_identity_id::text
    AND grant_id IS NOT NULL AND previous_digest IS NOT NULL)
);
