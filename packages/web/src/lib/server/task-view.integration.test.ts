import { describe, expect, it, vi } from "vitest";
import { createMockWebDeps } from "../../../../../test/helpers/web-deps";
import { buildAgentRecord, buildTaskRecord } from "../../../../../test/helpers/factories";
import { getTaskView } from "./task-view";

describe("task view loader", () => {
  it("returns a detailed child task view", async () => {
    const workflows = {
      describeWorkflow: vi.fn().mockResolvedValue({
        runId: "run-task",
        status: { name: "RUNNING" },
        memo: {},
      }),
      queryWorkflow: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        taskId: "task-child",
        agentId: "agent-1",
        isRoot: false,
        phase: "SLEEPING",
        logicalStatus: "SLEEPING",
        turnNumber: 7,
        lastStopReason: "Waiting on reply",
        nextWakeAt: "2026-04-11T15:00:00.000Z",
        pendingEmailCount: 0,
        pendingOwnerCount: 0,
        pendingScheduleCount: 0,
      }),
    };
    const deps = createMockWebDeps({ workflows });
    const db = deps.db as unknown as {
      task: { findUnique: ReturnType<typeof vi.fn> };
      agent: { findUnique: ReturnType<typeof vi.fn> };
    };

    db.task.findUnique.mockResolvedValue({
      ...buildTaskRecord({
        taskId: "task-child",
        tag: "task-child",
        isRoot: false,
        objective: "Follow up with the venue",
      }),
      conversations: [
        {
          id: 11,
          role: "assistant",
          message: JSON.stringify({ role: "assistant", content: "Draft sent." }),
          timestamp: new Date("2026-04-11T12:00:00.000Z"),
        },
      ],
      turnLogs: [
        {
          id: 21,
          turnNumber: 7,
          fromState: "RUNNING",
          toState: "SLEEPING",
          trigger: "on_email",
          wakeReflection: "Need to wait for confirmation.",
          stopReason: "Waiting on reply",
          timestamp: new Date("2026-04-11T12:01:00.000Z"),
        },
      ],
      agent: buildAgentRecord(),
    });

    const view = await getTaskView("agent-1", "task-child", deps);

    expect(view).toEqual({
      agentId: "agent-1",
      agentName: "Avery",
      agentEmail: "avery@agentmail.test",
      ownerEmail: "owner@example.com",
      task: expect.objectContaining({
        taskId: "task-child",
        objective: "Follow up with the venue",
        workflowStatus: "RUNNING",
        runtimeSnapshot: expect.objectContaining({
          turnNumber: 7,
          nextWakeAt: "2026-04-11T15:00:00.000Z",
        }),
        conversations: [
          expect.objectContaining({
            id: 11,
            role: "assistant",
            timestamp: "2026-04-11T12:00:00.000Z",
          }),
        ],
        turnLogs: [
          expect.objectContaining({
            id: 21,
            stopReason: "Waiting on reply",
          }),
        ],
      }),
    });
  });

  it("returns null for a missing task", async () => {
    const deps = createMockWebDeps();
    const db = deps.db as unknown as {
      task: { findUnique: ReturnType<typeof vi.fn> };
    };

    db.task.findUnique.mockResolvedValue(null);

    await expect(getTaskView("agent-1", "missing", deps)).resolves.toBeNull();
  });

  it("returns null when the task belongs to another agent", async () => {
    const deps = createMockWebDeps();
    const db = deps.db as unknown as {
      task: { findUnique: ReturnType<typeof vi.fn> };
    };

    db.task.findUnique.mockResolvedValue(
      buildTaskRecord({
        taskId: "task-child",
        isRoot: false,
        agentId: "agent-2",
      }),
    );

    await expect(getTaskView("agent-1", "task-child", deps)).resolves.toBeNull();
  });

  it("returns null for root tasks", async () => {
    const deps = createMockWebDeps();
    const db = deps.db as unknown as {
      task: { findUnique: ReturnType<typeof vi.fn> };
    };

    db.task.findUnique.mockResolvedValue(
      buildTaskRecord({
        taskId: "task-root",
        isRoot: true,
      }),
    );

    await expect(getTaskView("agent-1", "task-root", deps)).resolves.toBeNull();
  });
});
