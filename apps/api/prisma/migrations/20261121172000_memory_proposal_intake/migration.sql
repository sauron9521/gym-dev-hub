-- Issue #40: append-only, scoped proposal intake foundation (no approval/writes to VERIFIED).
-- Dedicated Hub memory DB only. Use the explicit guarded db:migrate command.
CREATE TABLE memory_proposal_requests (
  repository VARCHAR(200) NOT NULL,
  agent_id UUID NOT NULL,
  session_id UUID NOT NULL,
  request_key UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL,
  memory_id UUID NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT memory_proposal_requests_pkey PRIMARY KEY (repository, agent_id, session_id, request_key),
  CONSTRAINT memory_proposal_requests_repository_fkey FOREIGN KEY (repository)
    REFERENCES memory_repositories(name) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT memory_proposal_requests_agent_fkey FOREIGN KEY (repository, agent_id)
    REFERENCES memory_agent_identities(repository, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT memory_proposal_requests_session_fkey FOREIGN KEY (repository, session_id)
    REFERENCES memory_sessions(repository, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT memory_proposal_requests_memory_fkey FOREIGN KEY (repository, memory_id)
    REFERENCES memory_records(repository, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT memory_proposal_requests_digest_ck CHECK (payload_digest ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX memory_proposal_requests_repository_memory_id_key
  ON memory_proposal_requests(repository, memory_id);

CREATE TABLE memory_mutation_audit (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  repository VARCHAR(200) NOT NULL,
  memory_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  task_id UUID NOT NULL,
  session_id UUID NOT NULL,
  action VARCHAR(40) NOT NULL,
  previous_digest CHAR(64),
  resulting_digest CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT memory_mutation_audit_repository_fkey FOREIGN KEY (repository)
    REFERENCES memory_repositories(name) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT memory_mutation_audit_memory_fkey FOREIGN KEY (repository, memory_id)
    REFERENCES memory_records(repository, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT memory_mutation_audit_agent_fkey FOREIGN KEY (repository, agent_id)
    REFERENCES memory_agent_identities(repository, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT memory_mutation_audit_task_fkey FOREIGN KEY (repository, task_id)
    REFERENCES memory_tasks(repository, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT memory_mutation_audit_session_fkey FOREIGN KEY (repository, session_id)
    REFERENCES memory_sessions(repository, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT memory_mutation_audit_action_ck CHECK (action = 'PROPOSE_MEMORY'),
  CONSTRAINT memory_mutation_audit_digest_ck
    CHECK (resulting_digest ~ '^[0-9a-f]{64}$' AND
      (previous_digest IS NULL OR previous_digest ~ '^[0-9a-f]{64}$'))
);
CREATE INDEX memory_mutation_audit_repository_memory_created_at_idx
  ON memory_mutation_audit(repository, memory_id, created_at);

-- Initial revision snapshot fires before source insert. Defer its provenance FK
-- to the transaction commit while preserving same-repository referential integrity.
ALTER TABLE memory_revisions
  DROP CONSTRAINT memory_revisions_repository_memory_id_source_id_fkey;
ALTER TABLE memory_revisions
  ADD CONSTRAINT memory_revisions_repository_memory_id_source_id_fkey
    FOREIGN KEY (repository, memory_id, source_id)
    REFERENCES memory_sources(repository, memory_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION hub_memory_append_revision() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO memory_revisions(
    id, repository, memory_id, revision, scope, kind, status,
    text, source_sha, source_id, changed_by, created_at
  ) VALUES (
    gen_random_uuid(), NEW.repository, NEW.id, NEW.revision, NEW.scope, NEW.kind,
    NEW.status, NEW.text, NEW.source_sha,
    NULLIF(current_setting('hub.memory.source_id', true), '')::uuid,
    COALESCE(NULLIF(current_setting('hub.memory.actor_id', true), ''), 'unattributed-db-write'),
    NOW()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memory_proposal_requests_immutable_trigger
  BEFORE UPDATE OR DELETE ON memory_proposal_requests
  FOR EACH ROW EXECUTE FUNCTION hub_memory_no_mutable_history();
CREATE TRIGGER memory_mutation_audit_immutable_trigger
  BEFORE UPDATE OR DELETE ON memory_mutation_audit
  FOR EACH ROW EXECUTE FUNCTION hub_memory_no_mutable_history();
