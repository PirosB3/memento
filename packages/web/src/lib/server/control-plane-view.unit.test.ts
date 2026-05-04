import { describe, expect, it, vi } from "vitest";
import { createMockWebDeps } from "../../../../../test/helpers/web-deps";
import { buildAgentRecord, buildTaskRecord } from "../../../../../test/helpers/factories";
import { getControlPlaneView } from "./control-plane-view";

function mockRuntimeDeps() {
  return {
    describeWorkflow: vi.fn().mockResolvedValue({
      runId: "run-1",
      status: { name: "RUNNING" },
      memo: {},
    }),
    queryWorkflow: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      taskId: "task-root",
      agentId: "agent-1",
      isRoot: true,
      phase: "SLEEPING",
      logicalStatus: "SLEEPING",
      turnNumber: 2,
      lastStopReason: "Waiting",
      nextWakeAt: null,
      pendingEmailCount: 0,
      pendingOwnerCount: 0,
      pendingScheduleCount: 0,
    }),
  };
}

function setupControlPlaneDeps() {
  const rootTask = buildTaskRecord({
    taskId: "task-root",
    tag: "root-agent-1",
    isRoot: true,
    objective: "Main thread",
  });
  const childTask = buildTaskRecord({
    taskId: "task-child",
    tag: "child-tag",
    isRoot: false,
    objective: "Follow up with the venue",
  });
  const firstAgent = buildAgentRecord({
    agentId: "agent-1",
    name: "Avery",
    agentEmail: "avery@agentmail.test",
    profileImageUrl: "https://pub-example.test/pfps/avery.png",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  });
  const secondAgent = buildAgentRecord({
    agentId: "agent-2",
    name: "Blake",
    agentEmail: "blake@agentmail.test",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  const deps = createMockWebDeps({ workflows: mockRuntimeDeps() });
  const db = deps.db as unknown as {
    agent: { findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
    task: { findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  };

  db.agent.findMany.mockResolvedValue([
    {
      ...firstAgent,
      tasks: [
        { taskId: rootTask.taskId, agentId: rootTask.agentId, status: rootTask.status, isRoot: true },
        { taskId: childTask.taskId, agentId: childTask.agentId, status: childTask.status, isRoot: false },
      ],
    },
    {
      ...secondAgent,
      tasks: [
        { taskId: "task-root-2", agentId: "agent-2", status: "SLEEPING", isRoot: true },
      ],
    },
  ]);
  db.agent.findUnique.mockResolvedValue(firstAgent);
  db.task.findMany.mockResolvedValue([childTask, rootTask]);
  db.task.findUnique.mockImplementation(({ where }: { where: { taskId: string } }) => {
    if (where.taskId === rootTask.taskId) {
      return Promise.resolve({
        ...rootTask,
        conversations: [
          {
            id: 1,
            role: "assistant",
            message: JSON.stringify({ role: "assistant", content: "Root ready." }),
            timestamp: new Date("2026-01-02T12:00:00.000Z"),
          },
        ],
        turnLogs: [],
      });
    }
    if (where.taskId === childTask.taskId) {
      return Promise.resolve({
        ...childTask,
        conversations: [
          {
            id: 2,
            role: "assistant",
            message: JSON.stringify({ role: "assistant", content: "Child ready." }),
            timestamp: new Date("2026-01-02T12:05:00.000Z"),
          },
        ],
        turnLogs: [],
        agent: firstAgent,
      });
    }
    return Promise.resolve(null);
  });

  return deps;
}

describe("control plane view loader", () => {
  it("defaults to the first agent root task", async () => {
    const view = await getControlPlaneView({}, setupControlPlaneDeps());

    expect(view.agents).toHaveLength(2);
    expect(view.selectedAgent?.agentId).toBe("agent-1");
    expect(view.selectedTask).toEqual(expect.objectContaining({
      key: "root",
      title: "Root Task",
      email: "avery@agentmail.test",
    }));
  });

  it("loads a selected child task detail", async () => {
    const view = await getControlPlaneView(
      { agentId: "agent-1", taskKey: "task-child" },
      setupControlPlaneDeps(),
    );

    expect(view.selectedAgent?.agentId).toBe("agent-1");
    expect(view.selectedTask).toEqual(expect.objectContaining({
      key: "task-child",
      title: "Follow up with the venue",
      email: "avery+child-tag@agentmail.test",
    }));
    expect(view.selectedTask?.detail.conversations[0]?.id).toBe(2);
  });

  it("falls back to the first agent root task for stale selection params", async () => {
    const view = await getControlPlaneView(
      { agentId: "missing-agent", taskKey: "missing-task" },
      setupControlPlaneDeps(),
    );

    expect(view.selectedAgent?.agentId).toBe("agent-1");
    expect(view.selectedTask?.key).toBe("root");
  });

  it("does not fall back to another agent in strict route mode", async () => {
    const view = await getControlPlaneView(
      { agentId: "missing-agent", taskKey: "root" },
      setupControlPlaneDeps(),
      { fallbackToFirstAgent: false },
    );

    expect(view.agents).toHaveLength(2);
    expect(view.selectedAgent).toBeNull();
    expect(view.selectedTask).toBeNull();
  });

  it("falls back to the selected agent root task for an invalid task path", async () => {
    const view = await getControlPlaneView(
      { agentId: "agent-1", taskKey: "missing-task" },
      setupControlPlaneDeps(),
      { fallbackToFirstAgent: false },
    );

    expect(view.selectedAgent?.agentId).toBe("agent-1");
    expect(view.selectedTask?.key).toBe("root");
  });
});
