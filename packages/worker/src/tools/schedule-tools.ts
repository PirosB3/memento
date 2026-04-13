import { Type } from "@sinclair/typebox";
import { prisma, createLogger, TASK_QUEUE, getTemporalAddress } from "@summon/shared";
import type { AgentTool } from "../../pi-types.js";
import { Client, Connection } from "@temporalio/client";
import crypto from "crypto";

const log = createLogger("schedule-tools");

let temporalClient: Client | null = null;
async function getTemporalClient(): Promise<Client> {
  if (!temporalClient) {
    const connection = await Connection.connect({ address: getTemporalAddress() });
    temporalClient = new Client({ connection });
  }
  return temporalClient;
}

function resolveTargetWorkflowId(taskId: string, agentId: string, isRoot: boolean, targetTaskId?: string): string {
  if (!isRoot) {
    // Child can only target itself
    return `task-${taskId}`;
  }
  if (!targetTaskId || targetTaskId === taskId) {
    // Root targeting itself
    return `agent__${agentId}__root`;
  }
  // Root targeting a child task
  return `task-${targetTaskId}`;
}

export function createCreateScheduleTool(taskId: string, agentId: string, isRoot: boolean): AgentTool {
  return {
    name: "create_schedule",
    label: "Create Schedule",
    description: isRoot
      ? "Schedule a one-shot timer that will wake you or a child task at a specific time with a message. Use this when you need to do something at a specific time (e.g., 'send report at 8pm'). The timer fires even if you get woken up by other events in between."
      : "Schedule a one-shot timer that will wake you at a specific time with a message. Use this when you need to do something at a specific time (e.g., 'follow up tomorrow at 9am'). The timer fires even if you get woken up by other events in between.",
    parameters: isRoot
      ? Type.Object({
          fireAt: Type.String({ description: "ISO 8601 datetime for when the timer should fire (e.g., '2025-01-15T20:00:00Z')." }),
          message: Type.String({ description: "Message delivered when the timer fires. Should describe what action to take." }),
          taskId: Type.Optional(Type.String({ description: "Target task ID. Omit to schedule for yourself (root task)." })),
        })
      : Type.Object({
          fireAt: Type.String({ description: "ISO 8601 datetime for when the timer should fire (e.g., '2025-01-15T20:00:00Z')." }),
          message: Type.String({ description: "Message delivered when the timer fires. Should describe what action to take." }),
        }),
    execute: async (_toolCallId, params) => {
      try {
        const p = params as { fireAt: string; message: string; taskId?: string };

        const fireAtDate = new Date(p.fireAt);
        if (isNaN(fireAtDate.getTime())) {
          return {
            content: [{ type: "text" as const, text: `Invalid date: "${p.fireAt}". Use ISO 8601 format (e.g., '2025-01-15T20:00:00Z').` }],
            details: { error: true },
          };
        }

        if (fireAtDate.getTime() <= Date.now()) {
          return {
            content: [{ type: "text" as const, text: `Schedule time "${p.fireAt}" is in the past. Use a future time.` }],
            details: { error: true },
          };
        }

        const targetTaskId = isRoot ? (p.taskId ?? taskId) : taskId;
        const targetWorkflowId = resolveTargetWorkflowId(taskId, agentId, isRoot, p.taskId);
        const scheduleId = crypto.randomUUID();

        log.info(`Creating schedule: ${scheduleId} fireAt=${p.fireAt} target=${targetWorkflowId}`, { message: p.message });

        // Create DB record
        await prisma.schedule.create({
          data: {
            scheduleId,
            taskId: targetTaskId,
            agentId,
            targetWorkflowId,
            fireAt: fireAtDate,
            message: p.message,
            status: "PENDING",
          },
        });

        // Start the timer workflow
        const temporal = await getTemporalClient();
        await temporal.workflow.start("scheduleTimerWorkflow", {
          args: [scheduleId, targetWorkflowId, fireAtDate.getTime(), p.message],
          taskQueue: TASK_QUEUE,
          workflowId: `schedule-${scheduleId}`,
        });

        log.info(`Schedule created: ${scheduleId} workflow=schedule-${scheduleId}`);

        return {
          content: [{
            type: "text" as const,
            text: `Schedule created!\nSchedule ID: ${scheduleId}\nFires at: ${fireAtDate.toISOString()}\nMessage: ${p.message}\nTarget: ${targetWorkflowId}`,
          }],
          details: { scheduleId, fireAt: fireAtDate.toISOString(), targetWorkflowId },
        };
      } catch (error) {
        log.error("Failed to create schedule", error);
        return {
          content: [{ type: "text" as const, text: `Failed to create schedule: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

export function createListSchedulesTool(taskId: string, agentId: string, isRoot: boolean): AgentTool {
  return {
    name: "list_schedules",
    label: "List Schedules",
    description: isRoot
      ? "List scheduled timers. Optionally filter by task ID. Shows schedule ID, fire time, message, status, and target."
      : "List your scheduled timers. Shows schedule ID, fire time, message, and status.",
    parameters: isRoot
      ? Type.Object({
          taskId: Type.Optional(Type.String({ description: "Filter by task ID. Omit to list all schedules for this agent." })),
        })
      : Type.Object({}),
    execute: async (_toolCallId, params) => {
      try {
        const p = params as { taskId?: string };
        const where: Record<string, unknown> = { agentId };

        if (isRoot && p.taskId) {
          where.taskId = p.taskId;
        } else if (!isRoot) {
          where.taskId = taskId;
        }

        const schedules = await prisma.schedule.findMany({
          where,
          orderBy: { fireAt: "asc" },
        });

        if (schedules.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No scheduled timers." }],
            details: { count: 0 },
          };
        }

        const formatted = schedules.map((s) =>
          `Schedule: ${s.scheduleId}\n  Fire at: ${s.fireAt.toISOString()}\n  Message: ${s.message}\n  Status: ${s.status}\n  Target: ${s.targetWorkflowId}\n  Created: ${s.createdAt.toISOString()}`
        ).join("\n---\n");

        return {
          content: [{ type: "text" as const, text: formatted }],
          details: { count: schedules.length, schedules },
        };
      } catch (error) {
        log.error("Failed to list schedules", error);
        return {
          content: [{ type: "text" as const, text: `Failed to list schedules: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

export function createCancelScheduleTool(taskId: string, isRoot: boolean): AgentTool {
  return {
    name: "cancel_schedule",
    label: "Cancel Schedule",
    description: "Cancel a pending scheduled timer. The timer will not fire.",
    parameters: Type.Object({
      scheduleId: Type.String({ description: "The schedule ID to cancel." }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const { scheduleId } = params as { scheduleId: string };

        const schedule = await prisma.schedule.findUnique({ where: { scheduleId } });
        if (!schedule) {
          return {
            content: [{ type: "text" as const, text: `Schedule ${scheduleId} not found.` }],
            details: { error: true },
          };
        }

        // Child tasks can only cancel their own schedules
        if (!isRoot && schedule.taskId !== taskId) {
          return {
            content: [{ type: "text" as const, text: `You can only cancel your own schedules.` }],
            details: { error: true },
          };
        }

        if (schedule.status !== "PENDING") {
          return {
            content: [{ type: "text" as const, text: `Schedule ${scheduleId} is already ${schedule.status}. Only PENDING schedules can be cancelled.` }],
            details: { error: true, status: schedule.status },
          };
        }

        log.info(`Cancelling schedule: ${scheduleId}`);

        // Signal the timer workflow to cancel
        const temporal = await getTemporalClient();
        const handle = temporal.workflow.getHandle(`schedule-${scheduleId}`);
        await handle.signal("cancel_schedule");

        return {
          content: [{ type: "text" as const, text: `Schedule ${scheduleId} has been cancelled.` }],
          details: { scheduleId },
        };
      } catch (error) {
        log.error("Failed to cancel schedule", error);
        return {
          content: [{ type: "text" as const, text: `Failed to cancel schedule: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}
