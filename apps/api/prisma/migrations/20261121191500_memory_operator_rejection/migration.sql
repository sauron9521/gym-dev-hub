-- Add only the proposed-record rejection transition to the existing immutable
-- mutation audit. A rejected record is terminal and is never a verified read.
-- This migration depends on 20261121183000_memory_operator_approval.
ALTER TABLE memory_mutation_audit
  DROP CONSTRAINT memory_mutation_audit_action_ck;
ALTER TABLE memory_mutation_audit
  ADD CONSTRAINT memory_mutation_audit_action_ck CHECK (
    (
      action = 'PROPOSE_MEMORY'
      AND operator_actor_id IS NULL AND grant_id IS NULL
      AND previous_digest IS NULL
    )
    OR
    (
      action IN ('APPROVE_MEMORY_PROPOSAL', 'REJECT_MEMORY_PROPOSAL')
      AND operator_actor_id = 'local-operator'
      AND grant_id IS NOT NULL AND previous_digest IS NOT NULL
    )
  );

-- Guard against changing unverified proposals directly to revoked without
-- an explicit operator action in the same DB transaction. The operator service
-- sets a transaction-local action before the CAS update.
CREATE OR REPLACE FUNCTION hub_memory_record_rejection_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'PROPOSED' AND NEW.status = 'REVOKED'
     AND COALESCE(current_setting('hub.memory.operator_action', true),'')
       <> 'REJECT_MEMORY_PROPOSAL' THEN
    RAISE EXCEPTION 'operator action required to reject memory proposal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memory_operator_rejection_guard
  BEFORE UPDATE ON memory_records
  FOR EACH ROW EXECUTE FUNCTION hub_memory_record_rejection_guard();
