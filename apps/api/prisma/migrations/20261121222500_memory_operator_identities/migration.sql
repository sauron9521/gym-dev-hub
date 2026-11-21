-- Local Hub operator identities are independent from AGENT, GitHub, Docker and
-- worktree grants. Never persist raw tokens or a reusable operator secret.
CREATE TABLE memory_operator_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository VARCHAR(200) NOT NULL REFERENCES memory_repositories(name)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  handle VARCHAR(48) NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('REVIEWER','AUDITOR')),
  token_digest CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ(3) NOT NULL,
  revoked_at TIMESTAMPTZ(3),
  CONSTRAINT memory_operator_identities_handle_ck
    CHECK (handle ~ '^[a-z][a-z0-9_-]{2,47}$'),
  CONSTRAINT memory_operator_identities_lifetime_ck CHECK (expires_at > created_at),
  CONSTRAINT memory_operator_identities_digest_ck
    CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memory_operator_identities_unique_handle UNIQUE (repository,handle),
  CONSTRAINT memory_operator_identities_repo_id_unique UNIQUE (repository,id),
  CONSTRAINT memory_operator_identities_unique_digest UNIQUE (token_digest)
);
CREATE INDEX memory_operator_active_lookup_idx
  ON memory_operator_identities(repository,role,expires_at)
  WHERE revoked_at IS NULL;

-- Only metadata is kept: which identity was created/revoked by the bootstrap
-- root credential. No source note, text, token, URL, secret or prompt.
CREATE TABLE memory_operator_identity_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository VARCHAR(200) NOT NULL,
  operator_id UUID NOT NULL,
  action VARCHAR(16) NOT NULL CHECK (action IN ('ISSUED','REVOKED')),
  actor VARCHAR(32) NOT NULL DEFAULT 'bootstrap-root'
    CHECK (actor = 'bootstrap-root'),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT memory_operator_identity_audit_operator_fk
    FOREIGN KEY (repository,operator_id) REFERENCES memory_operator_identities(repository,id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX memory_operator_identity_audit_lookup_idx
  ON memory_operator_identity_audit(repository,operator_id,created_at);

-- Revoked identities cannot be reinstated, rotated or reassigned by a later
-- UPDATE. All role changes require a fresh explicit identity in a later slice.
CREATE OR REPLACE FUNCTION hub_memory_operator_identity_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operator identity deletion forbidden';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.repository IS DISTINCT FROM OLD.repository
    OR NEW.handle IS DISTINCT FROM OLD.handle
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR (OLD.revoked_at IS NOT NULL
      AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL)
  THEN
    RAISE EXCEPTION 'operator identity is immutable except one-way revocation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memory_operator_identity_guard
  BEFORE UPDATE OR DELETE ON memory_operator_identities
  FOR EACH ROW EXECUTE FUNCTION hub_memory_operator_identity_guard();

CREATE OR REPLACE FUNCTION hub_memory_operator_identity_audit_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'operator identity audit is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER memory_operator_identity_audit_guard
  BEFORE UPDATE OR DELETE ON memory_operator_identity_audit
  FOR EACH ROW EXECUTE FUNCTION hub_memory_operator_identity_audit_guard();
