-- CreateTable
CREATE TABLE "agents" (
    "agent_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agent_email" TEXT NOT NULL,
    "owner_email" TEXT NOT NULL,
    "soul" TEXT NOT NULL,
    "boundaries" TEXT NOT NULL,
    "tools" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "temporal_run_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("agent_id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "task_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "is_root" BOOLEAN NOT NULL DEFAULT false,
    "parent_task_id" TEXT,
    "temporal_run_id" TEXT,
    "max_turns" INTEGER NOT NULL DEFAULT 20,
    "timeout_hours" INTEGER NOT NULL DEFAULT 72,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" SERIAL NOT NULL,
    "task_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_turn_logs" (
    "id" SERIAL NOT NULL,
    "task_id" TEXT NOT NULL,
    "turn_number" INTEGER NOT NULL,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "wake_reflection" TEXT,
    "stop_reason" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_turn_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "schedule_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "target_workflow_id" TEXT NOT NULL,
    "fire_at" TIMESTAMP(3) NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("schedule_id")
);

-- CreateTable
CREATE TABLE "processed_emails" (
    "message_id" TEXT NOT NULL,
    "inbox_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_emails_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_agent_email_key" ON "agents"("agent_email");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_tag_key" ON "tasks"("tag");

-- CreateIndex
CREATE INDEX "tasks_agent_id_idx" ON "tasks"("agent_id");

-- CreateIndex
CREATE INDEX "tasks_tag_idx" ON "tasks"("tag");

-- CreateIndex
CREATE INDEX "conversations_task_id_id_idx" ON "conversations"("task_id", "id");

-- CreateIndex
CREATE INDEX "agent_turn_logs_task_id_turn_number_idx" ON "agent_turn_logs"("task_id", "turn_number");

-- CreateIndex
CREATE INDEX "schedules_task_id_idx" ON "schedules"("task_id");

-- CreateIndex
CREATE INDEX "schedules_agent_id_idx" ON "schedules"("agent_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("task_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("task_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_turn_logs" ADD CONSTRAINT "agent_turn_logs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("task_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("task_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;
