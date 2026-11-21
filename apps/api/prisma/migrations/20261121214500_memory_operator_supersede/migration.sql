-- Issue #40: one-to-one, operator-reviewed VERIFIED revision-2 supersession.
-- Existing immutable record/source/revision/audit history remains append-only.
ALTER TABLE memory_mutation_audit DROP CONSTRAINT memory_mutation_audit_action_ck;
ALTER TABLE memory_mutation_audit ADD CONSTRAINT memory_mutation_audit_action_ck CHECK (
  (action = 'PROPOSE_MEMORY' AND operator_actor_id IS NULL
    AND grant_id IS NULL AND previous_digest IS NULL)
  OR
  (action IN (
      'APPROVE_MEMORY_PROPOSAL','REJECT_MEMORY_PROPOSAL',
      'REVOKE_MEMORY_RECORD','SUPERSEDE_MEMORY_RECORD')
    AND operator_actor_id = 'local-operator'
    AND grant_id IS NOT NULL AND previous_digest IS NOT NULL)
);

-- Prevent two old records from becoming predecessors of the same replacement.
CREATE UNIQUE INDEX memory_supersession_one_predecessor_idx
  ON memory_records(repository,superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

CREATE OR REPLACE FUNCTION hub_memory_record_rejection_guard()
RETURNS TRIGGER AS $$
DECLARE
  linked RECORD;
BEGIN
  IF OLD.status = 'REVOKED' OR OLD.status = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'terminal memory cannot change';
  END IF;

  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id
     AND NOT (
       OLD.status = 'VERIFIED' AND NEW.status = 'SUPERSEDED'
       AND OLD.superseded_by_id IS NULL AND NEW.superseded_by_id IS NOT NULL
       AND current_setting('hub.memory.operator_action',true) = 'SUPERSEDE_MEMORY_RECORD'
     ) THEN
    RAISE EXCEPTION 'supersession link requires operator transition';
  END IF;

  IF OLD.status = 'PROPOSED' THEN
    IF NEW.status = 'REVOKED'
       AND COALESCE(current_setting('hub.memory.operator_action',true),'')
         <> 'REJECT_MEMORY_PROPOSAL' THEN
      RAISE EXCEPTION 'operator action required to reject proposal';
    END IF;
    IF NEW.status = 'SUPERSEDED' THEN
      RAISE EXCEPTION 'unverified proposal cannot supersede';
    END IF;
  END IF;

  IF OLD.status = 'VERIFIED' THEN
    IF NEW.verified_by IS DISTINCT FROM OLD.verified_by
      OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
      RAISE EXCEPTION 'verification metadata is immutable';
    END IF;
    IF NEW.status = 'REVOKED' THEN
      IF COALESCE(current_setting('hub.memory.operator_action',true),'')
          <> 'REVOKE_MEMORY_RECORD'
        OR NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id THEN
        RAISE EXCEPTION 'verified revocation requires operator action';
      END IF;
    ELSIF NEW.status = 'SUPERSEDED' THEN
      IF COALESCE(current_setting('hub.memory.operator_action',true),'')
           <> 'SUPERSEDE_MEMORY_RECORD'
        OR OLD.superseded_by_id IS NOT NULL OR NEW.superseded_by_id IS NULL
        OR NEW.id = NEW.superseded_by_id THEN
        RAISE EXCEPTION 'verified supersession requires a distinct replacement';
      END IF;

      SELECT target.repository, target.scope, target.kind,
             target.task_id, target.session_id, target.agent_id,
             target.status, target.revision, target.expires_at
        INTO linked FROM memory_records target
        WHERE target.repository = NEW.repository
          AND target.id = NEW.superseded_by_id;
      IF NOT FOUND OR linked.status <> 'VERIFIED' OR linked.revision <> 2
        OR linked.scope IS DISTINCT FROM OLD.scope
        OR linked.kind IS DISTINCT FROM OLD.kind
        OR linked.task_id IS DISTINCT FROM OLD.task_id
        OR linked.session_id IS DISTINCT FROM OLD.session_id
        OR linked.agent_id IS DISTINCT FROM OLD.agent_id
        OR (linked.expires_at IS NOT NULL AND linked.expires_at <= NOW()) THEN
        RAISE EXCEPTION 'replacement must be same-owner verified record';
      END IF;
    ELSE
      RAISE EXCEPTION 'verified memory requires approved terminal transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
