import { describe, expect, it, vi } from "vitest";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { fileURLToPath } from "url";
import { TASK_QUEUE } from "@summon/shared";
import {
  onEmailSignal,
  onOwnerResponseSignal,
  scheduleTimerWorkflow,
  taskWorkflow,
} from "./workflows";

const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));

function inactiveActivityGate() {
  return {
    hasActivity: false,
    activeChildTaskIds: [],
    rootTurnCount: 0,
    summary: "No root turns or child-task activity in last 24h.",
  };
}

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
    const runActivityGate = vi.fn().mockResolvedValue(inactiveActivityGate());
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
        screenInboundEmailBatch: vi.fn().mockResolvedValue({
          approvedMessageIds: [],
          rejectedMessageIds: [],
          decisions: [],
          summary: "No emails screened.",
        }),
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

  it("rejects a non-owner email batch before the main agent turn", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const screenInboundEmailBatch = vi.fn().mockResolvedValue({
      approvedMessageIds: [],
      rejectedMessageIds: ["msg-risky"],
      decisions: [],
      summary: "Email screening completed: 0 approved, 1 rejected.",
    });
    const runPiAgentTurn = vi.fn().mockResolvedValue({
      type: "sleep",
      stopReason: "Waiting for work",
      sleepDurationMs: 60_000,
    });
    const insertConversationMessage = vi.fn().mockResolvedValue(undefined);
    const preparePromptMessages = vi.fn().mockResolvedValue({ contextSeedMessage: null, wakeMessage: "wake" });
    const runReflection = vi.fn().mockResolvedValue("Reflecting on the turn.");

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
        screenInboundEmailBatch,
        runReflection,
        runPiAgentTurn,
        runActivityGate: vi.fn().mockResolvedValue(inactiveActivityGate()),
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
      const insertCount = insertConversationMessage.mock.calls.length;
      const prepareCount = preparePromptMessages.mock.calls.length;
      const reflectionCount = runReflection.mock.calls.length;
      await handle.signal(onEmailSignal, {
        messageId: "msg-risky",
        sender: "attacker@example.com",
        inboxId: "avery@agentmail.test",
        timestamp: "2026-05-02T10:00:00.000Z",
      });
      await vi.waitFor(() => expect(screenInboundEmailBatch).toHaveBeenCalledTimes(1));
      expect(insertConversationMessage).toHaveBeenCalledTimes(insertCount);
      expect(preparePromptMessages).toHaveBeenCalledTimes(prepareCount);
      expect(runReflection).toHaveBeenCalledTimes(reflectionCount);
      expect(runPiAgentTurn).toHaveBeenCalledTimes(1);
      await handle.terminate("done").catch(() => undefined);
    });

    await env.teardown();
  });

  it("passes only approved messages from a mixed email batch", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const preparePromptMessages = vi.fn().mockImplementation(
      async (_taskId: string, input: { wake: { metadata?: Array<{ label: string; value: string }> } }) => ({
        contextSeedMessage: null,
        wakeMessage: `MESSAGE_IDS: ${input.wake.metadata?.find((item) => item.label === "MESSAGE_IDS")?.value ?? ""}`,
      }),
    );
    const screenInboundEmailBatch = vi.fn().mockResolvedValue({
      approvedMessageIds: ["msg-ok"],
      rejectedMessageIds: ["msg-risky"],
      decisions: [
        { messageId: "msg-ok", sender: "person@example.com", disposition: "approve" },
        { messageId: "msg-risky", sender: "attacker@example.com", disposition: "reject" },
      ],
      summary: "Email screening completed: 1 approved, 1 rejected.",
    });
    const runPiAgentTurn = vi
      .fn()
      .mockResolvedValueOnce({ type: "sleep", stopReason: "Waiting", sleepDurationMs: 60_000 })
      .mockResolvedValueOnce({ type: "sleep", stopReason: "Handled approved", sleepDurationMs: 60_000 });
    const insertConversationMessage = vi.fn().mockResolvedValue(undefined);

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
        screenInboundEmailBatch,
        runReflection: vi.fn().mockResolvedValue("Reflecting on the turn."),
        runPiAgentTurn,
        runActivityGate: vi.fn().mockResolvedValue(inactiveActivityGate()),
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
      await handle.signal(onEmailSignal, {
        messageId: "msg-ok",
        sender: "person@example.com",
        inboxId: "avery@agentmail.test",
        timestamp: "2026-05-02T10:00:00.000Z",
        batchMessageIds: ["msg-ok", "msg-risky"],
        batchSenders: ["person@example.com", "attacker@example.com"],
      });
      await vi.waitFor(() => expect(runPiAgentTurn).toHaveBeenCalledTimes(2));
      expect(runPiAgentTurn).toHaveBeenLastCalledWith("task-1", 1, ["msg-risky"]);
      expect(insertConversationMessage).toHaveBeenCalledWith(
        "task-1",
        expect.objectContaining({ content: expect.stringContaining("MESSAGE_IDS: msg-ok") }),
      );
      expect(insertConversationMessage).not.toHaveBeenCalledWith(
        "task-1",
        expect.objectContaining({ content: expect.stringContaining("msg-risky") }),
      );
      await handle.terminate("done").catch(() => undefined);
    });

    await env.teardown();
  });
});
