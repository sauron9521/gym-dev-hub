-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('FACT', 'DECISION', 'CONSTRAINT', 'PROPOSAL');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('PROPOSED', 'VERIFIED', 'SUPERSEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "MemoryScope" AS ENUM ('PROJECT', 'TASK', 'SESSION');

-- CreateEnum
CREATE TYPE "MemorySourceType" AS ENUM ('GITHUB', 'WORKSPACE', 'HUMAN', 'AGENT');

-- CreateTable
CREATE TABLE "memory_repositories" (
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_repositories_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "memory_tasks" (
    "id" UUID NOT NULL,
    "repository" VARCHAR(200) NOT NULL,
    "external_ref" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_agent_identities" (
    "id" UUID NOT NULL,
    "repository" VARCHAR(200) NOT NULL,
    "external_ref" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_agent_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_sessions" (
    "id" UUID NOT NULL,
    "repository" VARCHAR(200) NOT NULL,
    "external_ref" VARCHAR(255) NOT NULL,
    "task_id" UUID,
    "agent_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_records" (
    "id" UUID NOT NULL,
    "repository" VARCHAR(200) NOT NULL,
    "scope" "MemoryScope" NOT NULL,
    "kind" "MemoryKind" NOT NULL,
    "status" "MemoryStatus" NOT NULL DEFAULT 'PROPOSED',
    "text" VARCHAR(4096) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "task_id" UUID,
    "session_id" UUID,
    "agent_id" UUID,
    "source_sha" VARCHAR(40),
    "expires_at" TIMESTAMPTZ(3),
    "verified_by" VARCHAR(200),
    "verified_at" TIMESTAMPTZ(3),
    "superseded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memory_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_sources" (
    "id" UUID NOT NULL,
    "repository" VARCHAR(200) NOT NULL,
    "memory_id" UUID NOT NULL,
    "source_type" "MemorySourceType" NOT NULL,
    "actor_id" VARCHAR(200) NOT NULL,
    "source_ref" VARCHAR(512) NOT NULL,
    "source_sha" VARCHAR(40),
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_revisions" (
    "id" UUID NOT NULL,
    "repository" VARCHAR(200) NOT NULL,
    "memory_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "scope" "MemoryScope" NOT NULL,
    "kind" "MemoryKind" NOT NULL,
    "status" "MemoryStatus" NOT NULL,
    "text" VARCHAR(4096) NOT NULL,
    "source_sha" VARCHAR(40),
    "source_id" UUID,
    "changed_by" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_tasks_repository_created_at_idx" ON "memory_tasks"("repository", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_tasks_repository_id_key" ON "memory_tasks"("repository", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_tasks_repository_external_ref_key" ON "memory_tasks"("repository", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "memory_agent_identities_repository_id_key" ON "memory_agent_identities"("repository", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_agent_identities_repository_external_ref_key" ON "memory_agent_identities"("repository", "external_ref");

-- CreateIndex
CREATE INDEX "memory_sessions_repository_task_id_idx" ON "memory_sessions"("repository", "task_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_sessions_repository_id_key" ON "memory_sessions"("repository", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_sessions_repository_external_ref_key" ON "memory_sessions"("repository", "external_ref");

-- CreateIndex
CREATE INDEX "memory_records_repository_scope_task_id_kind_status_updated_idx" ON "memory_records"("repository", "scope", "task_id", "kind", "status", "updated_at");

-- CreateIndex
CREATE INDEX "memory_records_repository_scope_session_id_updated_at_idx" ON "memory_records"("repository", "scope", "session_id", "updated_at");

-- CreateIndex
CREATE INDEX "memory_records_repository_status_expires_at_idx" ON "memory_records"("repository", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_records_repository_id_key" ON "memory_records"("repository", "id");

-- CreateIndex
CREATE INDEX "memory_sources_repository_memory_id_observed_at_idx" ON "memory_sources"("repository", "memory_id", "observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_sources_repository_memory_id_id_key" ON "memory_sources"("repository", "memory_id", "id");

-- CreateIndex
CREATE INDEX "memory_revisions_repository_memory_id_created_at_idx" ON "memory_revisions"("repository", "memory_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_revisions_repository_memory_id_revision_key" ON "memory_revisions"("repository", "memory_id", "revision");

-- AddForeignKey
ALTER TABLE "memory_tasks" ADD CONSTRAINT "memory_tasks_repository_fkey" FOREIGN KEY ("repository") REFERENCES "memory_repositories"("name") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_agent_identities" ADD CONSTRAINT "memory_agent_identities_repository_fkey" FOREIGN KEY ("repository") REFERENCES "memory_repositories"("name") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_sessions" ADD CONSTRAINT "memory_sessions_repository_fkey" FOREIGN KEY ("repository") REFERENCES "memory_repositories"("name") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_sessions" ADD CONSTRAINT "memory_sessions_repository_task_id_fkey" FOREIGN KEY ("repository", "task_id") REFERENCES "memory_tasks"("repository", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_sessions" ADD CONSTRAINT "memory_sessions_repository_agent_id_fkey" FOREIGN KEY ("repository", "agent_id") REFERENCES "memory_agent_identities"("repository", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_repository_fkey" FOREIGN KEY ("repository") REFERENCES "memory_repositories"("name") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_repository_task_id_fkey" FOREIGN KEY ("repository", "task_id") REFERENCES "memory_tasks"("repository", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_repository_session_id_fkey" FOREIGN KEY ("repository", "session_id") REFERENCES "memory_sessions"("repository", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_repository_agent_id_fkey" FOREIGN KEY ("repository", "agent_id") REFERENCES "memory_agent_identities"("repository", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_repository_superseded_by_id_fkey" FOREIGN KEY ("repository", "superseded_by_id") REFERENCES "memory_records"("repository", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_repository_memory_id_fkey" FOREIGN KEY ("repository", "memory_id") REFERENCES "memory_records"("repository", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_repository_memory_id_fkey" FOREIGN KEY ("repository", "memory_id") REFERENCES "memory_records"("repository", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_repository_memory_id_source_id_fkey" FOREIGN KEY ("repository", "memory_id", "source_id") REFERENCES "memory_sources"("repository", "memory_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Restricted, repository-scoped foundation. Never import chat transcripts or
-- grant an agent permission by inserting a row. No read/write API exists.
ALTER TABLE "memory_repositories" ADD CONSTRAINT "memory_repository_slug_ck"
    CHECK ("name" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$');
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_record_revision_positive_ck" CHECK (revision > 0);
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revision_positive_ck" CHECK (revision > 0);
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_record_text_nonempty_ck" CHECK (length(btrim(text)) BETWEEN 1 AND 4096);
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_source_actor_nonempty_ck" CHECK (length(btrim(actor_id)) > 0 AND length(btrim(source_ref)) > 0);
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_record_scope_ck" CHECK (
    (scope = 'PROJECT' AND task_id IS NULL AND session_id IS NULL) OR
    (scope = 'TASK' AND task_id IS NOT NULL AND session_id IS NULL) OR
    (scope = 'SESSION' AND task_id IS NULL AND session_id IS NOT NULL)
);
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_record_verified_attribution_ck"
    CHECK (status <> 'VERIFIED' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL));
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_record_source_sha_ck"
    CHECK (source_sha IS NULL OR source_sha ~ '^[0-9a-fA-F]{40}$');
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_source_sha_ck"
    CHECK (source_sha IS NULL OR source_sha ~ '^[0-9a-fA-F]{40}$');
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revision_source_sha_ck"
    CHECK (source_sha IS NULL OR source_sha ~ '^[0-9a-fA-F]{40}$');

-- Prevent accidental direct writes from erasing the history or silently
-- replacing a version; compare-and-swap UPDATE WHERE revision = expected
-- will only allow one of two concurrent callers to advance the revision.
CREATE FUNCTION hub_memory_record_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memory records cannot be physically deleted without an approved retention migration';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.repository IS DISTINCT FROM OLD.repository OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'memory record identity and repository cannot change';
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

CREATE TRIGGER hub_memory_record_guard_trigger
  BEFORE UPDATE OR DELETE ON "memory_records"
  FOR EACH ROW EXECUTE FUNCTION hub_memory_record_guard();

-- Initial snapshot and every subsequent revision are created transactionally.
-- The actor is an explicit controlled DB session setting only in future #40;
-- default 'unattributed-db-write' cannot be mistaken for operator approval.
CREATE FUNCTION hub_memory_append_revision() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "memory_revisions"(
    id, repository, memory_id, revision, scope, kind, status,
    text, source_sha, source_id, changed_by, created_at
  ) VALUES (
    gen_random_uuid(), NEW.repository, NEW.id, NEW.revision, NEW.scope, NEW.kind, NEW.status,
    NEW.text, NEW.source_sha, NULL,
    COALESCE(NULLIF(current_setting('hub.memory.actor_id', true), ''), 'unattributed-db-write'),
    NOW()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hub_memory_revision_snapshot_trigger
  AFTER INSERT OR UPDATE ON "memory_records"
  FOR EACH ROW EXECUTE FUNCTION hub_memory_append_revision();

CREATE FUNCTION hub_memory_no_mutable_history() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'memory provenance and revision history are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hub_memory_revisions_immutable_trigger
  BEFORE UPDATE OR DELETE ON "memory_revisions"
  FOR EACH ROW EXECUTE FUNCTION hub_memory_no_mutable_history();
CREATE TRIGGER hub_memory_sources_immutable_trigger
  BEFORE UPDATE OR DELETE ON "memory_sources"
  FOR EACH ROW EXECUTE FUNCTION hub_memory_no_mutable_history();
