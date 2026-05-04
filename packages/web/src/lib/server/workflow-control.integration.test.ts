import { describe, expect, it, vi } from "vitest";
import { createMockWebDeps } from "../../../../../test/helpers/web-deps";
import { buildTaskRecord } from "../../../../../test/helpers/factories";
import { restartAgentWorkflows } from "./workflow-control";

describe("workflow control", () => {
  it("restores the root reflection timestamp from turn logs when older memos do not have it", async () => {
    const snapshot = {
      schemaVersion: 1,
      taskId: "task-root",
      agentId: "agent-1",
      isRoot: true,
      phase: "SLEEPING",
      logicalStatus: "SLEEPING",
      turnNumber: 11,
      lastStopReason: "Waiting for more work",
      nextWakeAt: null,
      pendingEmailCount: 0,
      pendingOwnerCount: 0,
      pendingScheduleCount: 0,
    };
    const workflows = {
      startTaskWorkflow: vi.fn().mockResolvedValue({ firstExecutionRunId: "run-2" }),
      describeWorkflow: vi.fn().mockResolvedValue({
        runId: "run-1",
        status: { name: "TERMINATED" },
        memo: { summonTaskRuntime: snapshot },
      }),
      queryWorkflow: vi.fn(),
      startScheduleWorkflow: vi.fn(),
      terminateWorkflow: vi.fn(),
      signalWorkflow: vi.fn(),
    };
    const deps = createMockWebDeps({ workflows });
    const db = deps.db as unknown as {
      task: {
        findFirst: ReturnType<typeof vi.fn>;
      };
      agent: {
        update: ReturnType<typeof vi.fn>;
      };
      schedule: {
        findMany: ReturnType<typeof vi.fn>;
      };
      agentTurnLog: {
        findFirst: ReturnType<typeof vi.fn>;
      };
    };

    db.task.findFirst.mockResolvedValue(
      buildTaskRecord({
        isRoot: true,
        taskId: "task-root",
        tag: "root",
        temporalRunId: "run-1",
      }),
    );
    db.agent.update.mockResolvedValue(undefined);
    db.schedule.findMany.mockResolvedValue([]);
    db.agentTurnLog.findFirst.mockResolvedValue({
      timestamp: new Date("2026-04-22T08:30:00.000Z"),
    });

    await restartAgentWorkflows("agent-1", deps);

    expect(workflows.startTaskWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-root",
        workflowId: "agent__agent-1__root",
        resumeInput: expect.objectContaining({
          resumedFrom: expect.objectContaining({
            lastReflectionAt: "2026-04-22T08:30:00.000Z",
          }),
        }),
      }),
    );
  });
});
