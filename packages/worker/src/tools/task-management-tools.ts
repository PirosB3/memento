import { Type } from "@sinclair/typebox";
import {
  prisma,
  createLogger,
  TASK_QUEUE,
  getTemporalAddress,
  publishTurnSnapshot,
  generateTaskSlug,
  ensureUniqueSlug,
  recordTaskThreadId,
  withSlugRetry,
} from "@summon/shared";
import { uuidv7 } from "uuidv7";
import type { AgentTool } from "../../pi-types.js";
import { Client, Connection } from "@temporalio/client";
import crypto from "crypto";

const log = createLogger("task-management");

type SpawnTaskParams = {
  objective: string;
  seed_thread_id?: string;
  attach_threadId?: string;
};

let temporalClient: Client | null = null;
async function getTemporalClient(): Promise<Client> {
  if (!temporalClient) {
    const connection = await Connection.connect({ address: getTemporalAddress() });
    temporalClient = new Client({ connection });
  }
  return temporalClient;
}

async function terminateChildTaskWorkflow(taskId: string): Promise<void> {
  const temporal = await getTemporalClient();
  const handle = temporal.workflow.getHandle(`task-${taskId}`);
  await handle.terminate("Cancelled by root task").catch((err) => {
    log.warn(`Could not terminate workflow task-${taskId}: ${String(err)}`);
  });
}

export function createSpawnTaskTool(agentId: string): AgentTool {
  return {
    name: "spawn_task",
    label: "Spawn Task",
    description:
      "Create a new child task with its own objective. The task starts immediately and runs independently. The agent's bare email address is used for all outbound mail; the new task gets a per-agent unique `slug` that appears in the email signature footer for operator debugging. This is non-blocking — use list_tasks() later to check on it.",
    parameters: Type.Object({
      objective: Type.String({
        description: "Clear, specific objective for the child task. Be detailed about what needs to be accomplished.",
      }),
      seed_thread_id: Type.Optional(Type.String({
        description: "Optional preferred slug. Must be unique for this agent — fails if it collides with an existing task's slug. If omitted, a slug is auto-generated from the objective.",
      })),
      attach_threadId: Type.Optional(Type.String({
        description: "Optional AgentMail threadId to immediately bind to this task — useful when spawning from a triaged inbound email.",
      })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const p = params as SpawnTaskParams;
        const objective = p.objective;
        const taskId = crypto.randomUUID();
        const tag = taskId;
        const now = new Date();

        const seedSlug = p.seed_thread_id?.trim();
        let initialSlug: string;
        if (seedSlug) {
          const collision = await prisma.task.findFirst({
            where: { agentId, slug: seedSlug },
            select: { taskId: true },
          });
          if (collision) {
            return {
              content: [{ type: "text" as const, text: `Slug "${seedSlug}" is already in use by task ${collision.taskId}. Pick a different seed_thread_id or omit it to auto-generate.` }],
              details: { error: true, reason: "SLUG_COLLISION" },
            };
          }
          initialSlug = seedSlug;
        } else {
          initialSlug = await ensureUniqueSlug(prisma, agentId, generateTaskSlug(objective, now));
        }

        const agentmailThreadId = p.attach_threadId?.trim() || null;

        log.info(`Spawning task: ${taskId} agent=${agentId} slug=${initialSlug}`, { objective });

        // Auto-generated slugs retry on the unique-index race; user-supplied
        // `seed_thread_id` does not — surface the collision as an error so the
        // operator picks a different one.
        const finalSlug = await withSlugRetry(
          async (slug) => {
            await prisma.$transaction(async (tx) => {
              await tx.task.create({
                data: {
                  taskId,
                  agentId,
                  tag,
                  slug,
                  objective,
                  status: "RUNNING",
                  isRoot: false,
                },
              });
              if (agentmailThreadId) {
                await recordTaskThreadId(tx, { taskId, agentmailThreadId });
              }
            });
            return slug;
          },
          initialSlug,
          async () => {
            if (seedSlug) throw new Error(`Slug "${seedSlug}" is already in use`);
            return ensureUniqueSlug(prisma, agentId, generateTaskSlug(objective, now));
          },
        );

        const temporal = await getTemporalClient();
        await temporal.workflow.start("taskWorkflow", {
          args: [taskId, agentId],
          taskQueue: TASK_QUEUE,
          workflowId: `task-${taskId}`,
        });

        log.info(`Task spawned: ${taskId} slug=${finalSlug}`);

        return {
          content: [{
            type: "text" as const,
            text: `Child task created!\nTask ID: ${taskId}\nSlug: ${finalSlug}\nObjective: ${objective}\n${agentmailThreadId ? `Bound AgentMail thread: ${agentmailThreadId}\n` : ""}\nThe task is now running independently.`,
          }],
          details: { taskId, tag, slug: finalSlug, objective, agentmailThreadId },
        };
      } catch (error) {
        log.error("Failed to spawn task", error);
        return {
          content: [{ type: "text" as const, text: `Failed to spawn task: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

export function createWakeTaskTool(): AgentTool {
  return {
    name: "wake_task",
    label: "Wake Task",
    description:
      "Wake a sleeping or completed child task with a message. The message is delivered to the child and it will process it on wake. Use this to steer tasks, update objectives, or provide new instructions. Errors if the task is already RUNNING — sleep and retry later.",
    parameters: Type.Object({
      taskId: Type.String({ description: "The task ID to wake" }),
      message: Type.String({ description: "Message to send to the child task. Can include new instructions, objective updates, or context." }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const { taskId, message } = params as { taskId: string; message: string };

        const task = await prisma.task.findUniqueOrThrow({ where: { taskId } });
        if (task.status === "RUNNING") {
          return {
            content: [{ type: "text" as const, text: `Task ${taskId} is currently RUNNING. Sleep and retry later.` }],
            details: { error: true, reason: "TASK_RUNNING" },
          };
        }

        log.info(`Waking task: ${taskId} (status=${task.status})`, { message });

        // Insert message into child's conversation
        await prisma.conversation.create({
          data: {
            taskId,
            role: "user",
            message: JSON.stringify({
              role: "user",
              content: `## INLINE ROOT TASK MESSAGE
Source: root task wake

${message}`,
              timestamp: Date.now(),
            }),
            orderingKey: uuidv7(),
          },
        });
        await publishTurnSnapshot(taskId, []).catch((err) => {
          log.warn(`publishTurnSnapshot after wake_task tool failed: ${String(err)}`);
        });

        // Signal the child workflow
        const temporal = await getTemporalClient();
        const handle = temporal.workflow.getHandle(`task-${taskId}`);
        await handle.signal(
          "on_owner_response",
          `inline:${JSON.stringify({ source: "root_task", message })}`,
        );

        return {
          content: [{ type: "text" as const, text: `Task ${taskId} has been woken with your message.` }],
          details: { taskId, message },
        };
      } catch (error) {
        log.error("Failed to wake task", error);
        return {
          content: [{ type: "text" as const, text: `Failed to wake task: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

export function createCancelTaskTool(): AgentTool {
  return {
    name: "cancel_task",
    label: "Cancel Task",
    description: "Cancel a child task by marking it as COMPLETED.",
    parameters: Type.Object({
      taskId: Type.String({ description: "The task ID to cancel" }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const { taskId } = params as { taskId: string };
        log.info(`Cancelling task: ${taskId}`);
        await prisma.task.update({
          where: { taskId },
          data: { status: "COMPLETED", completedAt: new Date(), lastActivityAt: new Date() },
        });
        await terminateChildTaskWorkflow(taskId);
        return {
          content: [{ type: "text" as const, text: `Task ${taskId} has been cancelled.` }],
          details: { taskId },
        };
      } catch (error) {
        log.error("Failed to cancel task", error);
        return {
          content: [{ type: "text" as const, text: `Failed to cancel task: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

export function createListTasksTool(agentId: string): AgentTool {
  return {
    name: "list_tasks",
    label: "List Tasks",
    description: "List all child tasks for this agent with their status and last stop reason.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const tasks = await prisma.task.findMany({
          where: { agentId, isRoot: false },
          orderBy: { createdAt: "desc" },
          include: {
            _count: { select: { agentmailThreadBindings: true } },
          },
        });

        const results = [];
        for (const t of tasks) {
          const lastLog = await prisma.agentTurnLog.findFirst({
            where: { taskId: t.taskId, stopReason: { not: null } },
            orderBy: { turnNumber: "desc" },
          });
          results.push({
            taskId: t.taskId,
            tag: t.tag,
            slug: t.slug,
            agentmailThreadCount: t._count.agentmailThreadBindings,
            objective: t.objective,
            status: t.status,
            lastStopReason: lastLog?.stopReason ?? null,
            createdAt: t.createdAt.toISOString(),
          });
        }

        const formatted = results.length === 0
          ? "No child tasks."
          : results.map((t) =>
              `Task: ${t.taskId}\n  Slug: ${t.slug ?? "(none)"}\n  Objective: ${t.objective}\n  Status: ${t.status}\n  AgentMail threads attached: ${t.agentmailThreadCount}\n  Last stop reason: ${t.lastStopReason ?? "none"}\n  Created: ${t.createdAt}`
            ).join("\n---\n");

        return {
          content: [{ type: "text" as const, text: formatted }],
          details: { count: results.length, tasks: results },
        };
      } catch (error) {
        log.error("Failed to list tasks", error);
        return {
          content: [{ type: "text" as const, text: `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

export function createGetTaskConversationTool(): AgentTool {
  return {
    name: "get_task_conversation",
    label: "Get Task Conversation",
    description: "Get recent conversation messages from a child task. Use this to understand what a child task has been doing.",
    parameters: Type.Object({
      taskId: Type.String({ description: "The task ID to get conversation for" }),
      limit: Type.Optional(Type.Number({ description: "Max messages to return (default 20)" })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const { taskId, limit } = params as { taskId: string; limit?: number };

        const messages = await prisma.conversation.findMany({
          where: { taskId },
          orderBy: { id: "desc" },
          take: limit ?? 20,
        });

        // oxlint-disable-next-line no-array-reverse -- target is ES2022, toReversed requires ES2023
        const formatted = [...messages].reverse().map((m) => {
          try {
            const parsed = JSON.parse(m.message);
            const content = typeof parsed.content === "string"
              ? parsed.content
              : Array.isArray(parsed.content)
                ? parsed.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n")
                : JSON.stringify(parsed.content);
            return `[${parsed.role}] ${content.slice(0, 500)}`;
          } catch {
            return `[${m.role}] ${m.message.slice(0, 500)}`;
          }
        }).join("\n\n");

        return {
          content: [{ type: "text" as const, text: formatted || "No conversation messages." }],
          details: { taskId, count: messages.length },
        };
      } catch (error) {
        log.error("Failed to get task conversation", error);
        return {
          content: [{ type: "text" as const, text: `Failed to get conversation: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

const VALID_CONFIG_FIELDS = ["soul", "boundaries", "tools"] as const;
type ConfigField = typeof VALID_CONFIG_FIELDS[number];

export function createAgentConfigTool(agentId: string): AgentTool {
  return {
    name: "agent_config",
    label: "Agent Config",
    description:
      "Read or write your agent configuration (SOUL, BOUNDARIES, TOOLS). Use 'read' to see current values, 'write' to update them. Write changes take effect on the next turn. Use this for permanent personality/behavior changes. For temporary preferences, use memory.md instead.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("write")]),
      field: Type.Union([Type.Literal("soul"), Type.Literal("boundaries"), Type.Literal("tools")]),
      value: Type.Optional(Type.String({ description: "New value for the field. Required for 'write' action." })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const p = params as { action: "read" | "write"; field: ConfigField; value?: string };

        if (!VALID_CONFIG_FIELDS.includes(p.field)) {
          return {
            content: [{ type: "text" as const, text: `Invalid field: ${p.field}. Must be one of: ${VALID_CONFIG_FIELDS.join(", ")}` }],
            details: { error: true },
          };
        }

        if (p.action === "read") {
          const agent = await prisma.agent.findUniqueOrThrow({ where: { agentId } });
          const value = agent[p.field];
          log.info(`Agent config read: ${agentId} field=${p.field}`);
          return {
            content: [{ type: "text" as const, text: `Current ${p.field.toUpperCase()}:\n\n${value}` }],
            details: { field: p.field, value },
          };
        }

        // Write
        if (!p.value) {
          return {
            content: [{ type: "text" as const, text: "Value is required for write action." }],
            details: { error: true },
          };
        }

        log.info(`Agent config write: ${agentId} field=${p.field}`, { value: p.value.slice(0, 200) });
        await prisma.agent.update({
          where: { agentId },
          data: { [p.field]: p.value },
        });

        return {
          content: [{ type: "text" as const, text: `${p.field.toUpperCase()} updated successfully. The change will take effect on the next turn.` }],
          details: { field: p.field },
        };
      } catch (error) {
        log.error("Failed to access agent config", error);
        return {
          content: [{ type: "text" as const, text: `Failed to access config: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}
