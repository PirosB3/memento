import type { PrismaClient } from "@prisma/client";

/**
 * Append an AgentMail threadId to `tasks.agentmail_thread_ids` for the given
 * task, deduping in-place. Idempotent: re-recording the same threadId is a no-op.
 *
 * Implemented as a single `UPDATE` with a server-side dedupe so we don't have
 * to read-then-write under contention. The `ARRAY_AGG(DISTINCT ...)` collapses
 * duplicates after concatenation.
 */
export async function recordTaskThreadId(
  prisma: PrismaClient,
  args: { taskId: string; agentmailThreadId: string },
): Promise<void> {
  const { taskId, agentmailThreadId } = args;
  await prisma.$executeRaw`
    UPDATE tasks
    SET agentmail_thread_ids = (
      SELECT COALESCE(ARRAY_AGG(DISTINCT id), ARRAY[]::text[])
      FROM unnest(agentmail_thread_ids || ARRAY[${agentmailThreadId}]::text[]) AS id
    )
    WHERE task_id = ${taskId}
  `;
}

export async function findTaskByAgentmailThreadId(
  prisma: PrismaClient,
  args: { agentId: string; agentmailThreadId: string },
): Promise<{ taskId: string } | null> {
  return prisma.task.findFirst({
    where: {
      agentId: args.agentId,
      agentmailThreadIds: { has: args.agentmailThreadId },
    },
    select: { taskId: true },
  });
}

export async function findTaskBySlug(
  prisma: PrismaClient,
  args: { agentId: string; slug: string },
): Promise<{ taskId: string; slug: string | null } | null> {
  return prisma.task.findFirst({
    where: { agentId: args.agentId, slug: args.slug },
    select: { taskId: true, slug: true },
  });
}
