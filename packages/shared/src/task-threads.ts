import type { Prisma, PrismaClient } from "@prisma/client";

type ThreadBindingDb = PrismaClient | Prisma.TransactionClient;

export class AgentMailThreadBindingConflictError extends Error {
  readonly agentmailThreadId: string;
  readonly requestedTaskId: string;
  readonly existingTaskId: string;

  constructor(args: {
    agentmailThreadId: string;
    requestedTaskId: string;
    existingTaskId: string;
  }) {
    super(
      `AgentMail thread ${args.agentmailThreadId} is already bound to task ${args.existingTaskId}; cannot bind it to task ${args.requestedTaskId}.`,
    );
    this.name = "AgentMailThreadBindingConflictError";
    this.agentmailThreadId = args.agentmailThreadId;
    this.requestedTaskId = args.requestedTaskId;
    this.existingTaskId = args.existingTaskId;
  }
}

/**
 * Bind an AgentMail threadId to a task.
 * Idempotent for the same task, but rejects attempts to bind the same
 * AgentMail thread to a different task.
 */
export async function recordTaskThreadId(
  prisma: ThreadBindingDb,
  args: { taskId: string; agentmailThreadId: string },
): Promise<void> {
  const { taskId, agentmailThreadId } = args;
  const [bound] = await prisma.$queryRaw<Array<{ task_id: string }>>`
    INSERT INTO agentmail_thread_bindings (agentmail_thread_id, task_id)
    VALUES (${agentmailThreadId}, ${taskId})
    ON CONFLICT (agentmail_thread_id) DO UPDATE
      SET last_seen_at = CURRENT_TIMESTAMP
      WHERE agentmail_thread_bindings.task_id = EXCLUDED.task_id
    RETURNING task_id
  `;
  if (bound) return;

  const existing = await prisma.agentMailThreadBinding.findUniqueOrThrow({
    where: { agentmailThreadId },
    select: { taskId: true },
  });
  throw new AgentMailThreadBindingConflictError({
    agentmailThreadId,
    requestedTaskId: taskId,
    existingTaskId: existing.taskId,
  });
}

export async function findTaskByAgentmailThreadId(
  prisma: ThreadBindingDb,
  args: { agentId: string; agentmailThreadId: string },
): Promise<{ taskId: string } | null> {
  return prisma.agentMailThreadBinding.findFirst({
    where: {
      agentmailThreadId: args.agentmailThreadId,
      task: { agentId: args.agentId },
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
