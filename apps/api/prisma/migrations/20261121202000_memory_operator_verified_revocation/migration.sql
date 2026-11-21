-- Issue #40: explicitly reviewed revocation of a verified first-generation record.
-- No delete, no supersede and no privilege extension for agents.
ALTER TABLE memory_mutation_audit DROP CONSTRAINT memory_mutation_audit_action_ck;
ALTER TABLE memory_mutation_audit ADD CONSTRAINT memory_mutation_audit_action_ck CHECK (
  (action = 'PROPOSE_MEMORY' AND operator_actor_id IS NULL
    AND grant_id IS NULL AND previous_digest IS NULL)
  OR
  (action IN ('APPROVE_MEMORY_PROPOSAL','REJECT_MEMORY_PROPOSAL','REVOKE_MEMORY_RECORD')
    AND operator_actor_id = 'local-operator'
    AND grant_id IS NOT NULL AND previous_digest IS NOT NULL)
);

CREATE OR REPLACE FUNCTION hub_memory_record_rejection_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'PROPOSED' AND NEW.status = 'REVOKED'
     AND COALESCE(current_setting('hub.memory.operator_action', true),'')
       <> 'REJECT_MEMORY_PROPOSAL' THEN
    RAISE EXCEPTION 'operator action required to reject memory proposal';
  END IF;
  IF OLD.status = 'VERIFIED' THEN
    IF NEW.status <> 'REVOKED'
      OR COALESCE(current_setting('hub.memory.operator_action',true),'')
        <> 'REVOKE_MEMORY_RECORD'
      OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
      OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
    THEN
      RAISE EXCEPTION 'verified memory requires explicit operator revocation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
