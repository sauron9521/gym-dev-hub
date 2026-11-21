-- Issue #40: local operator-approved PROPOSED -> VERIFIED, guarded by
-- one-use in-process intent grants and transactional compare-and-swap.
-- Existing memory proposals / immutable audits remain intact.
ALTER TABLE memory_mutation_audit
  ADD COLUMN operator_actor_id VARCHAR(80),
  ADD COLUMN grant_id UUID;
ALTER TABLE memory_mutation_audit
  DROP CONSTRAINT memory_mutation_audit_action_ck;
ALTER TABLE memory_mutation_audit
  ADD CONSTRAINT memory_mutation_audit_action_ck CHECK (
    (action = 'PROPOSE_MEMORY' AND operator_actor_id IS NULL AND grant_id IS NULL
      AND previous_digest IS NULL)
    OR
    (action = 'APPROVE_MEMORY_PROPOSAL' AND operator_actor_id = 'local-operator'
      AND grant_id IS NOT NULL AND previous_digest IS NOT NULL)
  );
CREATE UNIQUE INDEX memory_mutation_audit_unique_approval_grant_idx
  ON memory_mutation_audit(grant_id) WHERE grant_id IS NOT NULL;

-- Approved records must never be able to escape their original task/session,
-- repository or principal through a later revision. The source-linked
-- revision history relies on these ownership fields remaining immutable.
CREATE OR REPLACE FUNCTION hub_memory_record_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memory records cannot be physically deleted without an approved retention migration';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.repository IS DISTINCT FROM OLD.repository
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.text IS DISTINCT FROM OLD.text
    OR NEW.source_sha IS DISTINCT FROM OLD.source_sha THEN
    RAISE EXCEPTION 'memory record identity, ownership and source content are immutable';
  END IF;
  IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'memory revision must increase by exactly one';
  END IF;
  IF OLD.status = 'REVOKED' THEN
    RAISE EXCEPTION 'revoked memory is terminal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
