-- AlterTable: add slug + agentmail_thread_ids to tasks
ALTER TABLE "tasks" ADD COLUMN "slug" TEXT;
ALTER TABLE "tasks" ADD COLUMN "agentmail_thread_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateIndex: per-agent slug uniqueness (NULLs are distinct, so root tasks
-- with slug=NULL don't conflict)
CREATE UNIQUE INDEX "tasks_agent_id_slug_key" ON "tasks"("agent_id", "slug");

-- CreateIndex: GIN index for fast agentmail_thread_id → task lookup in the
-- gateway. Prisma DSL can't express GIN indexes; we add it manually.
CREATE INDEX "tasks_agentmail_thread_ids_idx" ON "tasks" USING GIN ("agentmail_thread_ids");
