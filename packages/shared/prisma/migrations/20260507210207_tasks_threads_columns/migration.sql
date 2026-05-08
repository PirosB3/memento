-- AlterTable: add per-agent task slug
ALTER TABLE "tasks" ADD COLUMN "slug" TEXT;

-- CreateIndex: per-agent slug uniqueness (NULLs are distinct, so root tasks
-- with slug=NULL don't conflict)
CREATE UNIQUE INDEX "tasks_agent_id_slug_key" ON "tasks"("agent_id", "slug");

-- CreateTable: one AgentMail native thread belongs to exactly one task per
-- AgentMail globally, while a task can own many AgentMail threads.
CREATE TABLE "agentmail_thread_bindings" (
    "agentmail_thread_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agentmail_thread_bindings_pkey" PRIMARY KEY ("agentmail_thread_id")
);

-- CreateIndex
CREATE INDEX "agentmail_thread_bindings_task_id_idx" ON "agentmail_thread_bindings"("task_id");

-- AddForeignKey
ALTER TABLE "agentmail_thread_bindings" ADD CONSTRAINT "agentmail_thread_bindings_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("task_id") ON DELETE CASCADE ON UPDATE CASCADE;
