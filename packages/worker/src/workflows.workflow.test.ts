import { describe, expect, it, vi } from "vitest";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { fileURLToPath } from "url";
import { TASK_QUEUE } from "@summon/shared";
import {
  onOwnerResponseSignal,
  scheduleTimerWorkflow,
  taskWorkflow,
} from "./workflows";

const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));

describe("workflows", () => {
  it("fires schedule timers through the schedule workflow", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const fireScheduleSignal = vi.fn().mockResolvedValue(undefined);
    const updateScheduleStatus = vi.fn().mockResolvedValue(undefined);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        fireScheduleSignal,
        updateScheduleStatus,
      },
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(scheduleTimerWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: "schedule-test",
        args: ["schedule-1", "task-1", Date.now() + 1_000, "Ping"],
      });
      await handle.result();
    });

    expect(fireScheduleSignal).toHaveBeenCalledWith("task-1", "schedule-1", "Ping");
    expect(updateScheduleStatus).not.toHaveBeenCalled();
    await env.teardown();
  });

  it("wakes a root task when the owner responds", async () => {
    const env = await TestWorkflowEnvironment.createLocal();
    const insertConversationMessage = vi.fn().mockResolvedValue(undefined);
    const runActivityGate = vi.fn().mockResolvedValue({
      hasActivity: false,
      activeChildTaskIds: [],
      rootTurnCount: 0,
      summary: "No root turns or child-task activity in last 24h.",
    });
    const preparePromptMessages = vi.fn().mockImplementation(
      async (
        _taskId: string,
        input: {
          includeContextSeed: boolean;
          wake: {
            wokenBy: string;
            metadata?: Array<{ label: string; value: string }>;
          };
        },
      ) => ({
        contextSeedMessage: input.includeContextSeed ? "## CONTEXT SEED" : null,
        wakeMessage: `## WAKE\nWOKEN BY: ${input.wake.wokenBy}\n${input.wake.metadata?.map((item) => `${item.label}: ${item.value}`).join("\n") ?? ""}`,
      }),
    );
    const runPiAgentTurn = vi
      .fn()
      .mockResolvedValueOnce({
        type: "sleep",
        stopReason: "Waiting for work",
        sleepDurationMs: 60_000,
      })
      .mockResolvedValueOnce({
        type: "sleep",
        stopReason: "Handled owner response",
        sleepDurationMs: 60_000,
      });

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        loadTaskFromDb: vi.fn().mockResolvedValue({
          taskId: "task-1",
          agentId: "agent-1",
          status: "RUNNING",
          isRoot: true,
        }),
        updateTaskStatus: vi.fn().mockResolvedValue(undefined),
        checkTaskExpired: vi.fn().mockResolvedValue(false),
        insertConversationMessage,
        insertTurnLog: vi.fn().mockResolvedValue(1),
        updateTurnLogReflection: vi.fn().mockResolvedValue(undefined),
        updateTurnLogStopReason: vi.fn().mockResolvedValue(undefined),
        preparePromptMessages,
        runReflection: vi.fn().mockResolvedValue("Reflecting on the turn."),
        runPiAgentTurn,
        runActivityGate,
        runChildReflectionStep: vi.fn(),
        fireScheduleSignal: vi.fn().mockResolvedValue(undefined),
        updateScheduleStatus: vi.fn().mockResolvedValue(undefined),
      },
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(taskWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: "agent__agent-1__root",
        args: ["task-1", "agent-1"],
      });

      await vi.waitFor(() => expect(runPiAgentTurn).toHaveBeenCalledTimes(1));
      await handle.signal(onOwnerResponseSignal, "msg-123");
      await vi.waitFor(() => expect(runPiAgentTurn).toHaveBeenCalledTimes(2));
      await handle.terminate("done").catch(() => undefined);
    });

    expect(preparePromptMessages).toHaveBeenCalled();
    expect(insertConversationMessage).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        content: expect.stringContaining("## WAKE"),
      }),
    );
    expect(insertConversationMessage).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        content: expect.stringContaining("MESSAGE_ID: msg-123"),
      }),
    );
    await env.teardown();
  });
});
