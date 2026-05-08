import { describe, expect, it, vi } from "vitest";
import { createMockWebDeps } from "../../../../../test/helpers/web-deps";
import { buildAgentRecord, buildTaskRecord } from "../../../../../test/helpers/factories";
import {
  buildEnrichedObjective,
  createTask,
  prepareTask,
  restartTask,
  stopTask,
  wakeRootTask,
} from "./task-services";

describe("task services", () => {
  it("builds an enriched objective from non-empty answers only", () => {
    const result = buildEnrichedObjective("Follow up with Alice", {
      Deadline: "Friday",
      Notes: "",
    });

    expect(result).toContain("Follow up with Alice");
    expect(result).toContain("Q: Deadline");
    expect(result).not.toContain("Q: Notes");
  });

  it("creates a task with enriched objective and starts the workflow", async () => {
    const workflows = {
      startTaskWorkflow: vi.fn().mockResolvedValue({ firstExecutionRunId: "run-1" }),
      terminateWorkflow: vi.fn(),
      describeWorkflow: vi.fn().mockResolvedValue({
        runId: "run-root",
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
        turnNumber: 1,
        lastStopReason: "Waiting",
        nextWakeAt: null,
        pendingEmailCount: 0,
        pendingOwnerCount: 0,
        pendingScheduleCount: 0,
      }),
      startScheduleWorkflow: vi.fn(),
    };
    const deps = createMockWebDeps({ workflows });
    const db = deps.db as unknown as {
      agent: { findUnique: ReturnType<typeof vi.fn> };
      task: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    };

    db.agent.findUnique.mockResolvedValue(buildAgentRecord());
    // findFirst is consulted for both (a) the root task lookup (isRoot=true)
    // and (b) per-slug uniqueness checks via ensureUniqueSlug. Branch on
    // `where` so the slug check returns null (slug is free) without looping.
    db.task.findFirst.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      if (args?.where && "slug" in args.where) return null;
      return buildTaskRecord({ isRoot: true, taskId: "task-root" });
    });
    db.task.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      buildTaskRecord({ ...data, isRoot: false, tag: data.taskId }),
    );

    const task = await createTask(
      {
        agentId: "agent-1",
        objective: "Follow up with Alice",
        answers: {
          Deadline: "Friday",
        },
      },
      deps,
    );

    expect(task.objective).toContain("Additional context");
    expect(task.slug).toMatch(/^follow-up-with-alice/);
    expect(workflows.startTaskWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        taskId: task.taskId,
        workflowId: `task-${task.taskId}`,
      }),
    );
  });

  it("creates an initial AgentMail thread binding when attachThreadId is provided", async () => {
    const workflows = {
      startTaskWorkflow: vi.fn().mockResolvedValue({ firstExecutionRunId: "run-1" }),
      terminateWorkflow: vi.fn(),
      describeWorkflow: vi.fn().mockResolvedValue({
        runId: "run-root",
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
        turnNumber: 1,
        lastStopReason: "Waiting",
        nextWakeAt: null,
        pendingEmailCount: 0,
        pendingOwnerCount: 0,
        pendingScheduleCount: 0,
      }),
      startScheduleWorkflow: vi.fn(),
    };
    const deps = createMockWebDeps({ workflows });
    const db = deps.db as unknown as {
      agent: { findUnique: ReturnType<typeof vi.fn> };
      task: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
      agentMailThreadBinding: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
    };

    db.agent.findUnique.mockResolvedValue(buildAgentRecord());
    db.task.findFirst.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      if (args?.where && "slug" in args.where) return null;
      return buildTaskRecord({ isRoot: true, taskId: "task-root" });
    });
    db.task.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      buildTaskRecord({ ...data, isRoot: false, tag: data.taskId }),
    );
    db.agentMailThreadBinding.findUnique.mockResolvedValue(null);
    db.agentMailThreadBinding.create.mockResolvedValue(undefined);

    const task = await createTask(
      {
        agentId: "agent-1",
        objective: "Follow up with Alice",
        attachThreadId: "thread-AAA",
      },
      deps,
    );

    expect(db.task.create.mock.calls[0][0].data).not.toHaveProperty("agentmailThreadIds");
    expect(db.agentMailThreadBinding.create).toHaveBeenCalledWith({
      data: {
        taskId: task.taskId,
        agentmailThreadId: "thread-AAA",
      },
    });
    expect(workflows.startTaskWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.taskId }),
    );
  });

  it("prepares questions for an existing agent", async () => {
    const llm = {
      createText: vi.fn().mockResolvedValue('["Who is involved?","What is the deadline?"]'),
    };
    const deps = createMockWebDeps({ llm });
    const db = deps.db as unknown as {
      agent: { findUnique: ReturnType<typeof vi.fn> };
    };

    db.agent.findUnique.mockResolvedValue(buildAgentRecord());

    const result = await prepareTask(
      {
        agentId: "agent-1",
        objective: "Plan a dinner",
      },
      deps,
    );

    expect(result.questions).toEqual(["Who is involved?", "What is the deadline?"]);
  });

  it("stops child tasks using the child workflow id", async () => {
    const workflows = {
      startTaskWorkflow: vi.fn(),
      terminateWorkflow: vi.fn().mockResolvedValue(undefined),
      describeWorkflow: vi.fn().mockResolvedValue({
        runId: "run-1",
        status: { name: "RUNNING" },
        memo: {},
      }),
      queryWorkflow: vi.fn(),
      startScheduleWorkflow: vi.fn(),
    };
    const deps = createMockWebDeps({ workflows });
    const db = deps.db as unknown as {
      task: {
        findUnique: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
      };
      schedule: {
        findMany: ReturnType<typeof vi.fn>;
      };
    };

    db.task.findUnique.mockResolvedValue(buildTaskRecord({ isRoot: false, taskId: "task-child", tag: "task-child" }));
    db.task.update.mockResolvedValue(undefined);
    db.schedule.findMany.mockResolvedValue([]);

    await stopTask("agent-1", "task-child", deps);

    expect(workflows.terminateWorkflow).toHaveBeenCalledWith(
      "task-task-child",
      "Stopped from UI",
    );
  });

  it("restarts child tasks with a Temporal resume payload", async () => {
    const snapshot = {
      schemaVersion: 1,
      taskId: "task-child",
      agentId: "agent-1",
      isRoot: false,
      phase: "SLEEPING",
      logicalStatus: "SLEEPING",
      turnNumber: 4,
      lastStopReason: "Waiting for reply",
      nextWakeAt: null,
      pendingEmailCount: 0,
      pendingOwnerCount: 0,
      pendingScheduleCount: 0,
    };
    const workflows = {
      startTaskWorkflow: vi.fn().mockResolvedValue({ firstExecutionRunId: "run-2" }),
      terminateWorkflow: vi.fn(),
      describeWorkflow: vi.fn().mockResolvedValue({
        runId: "run-1",
        status: { name: "TERMINATED" },
        memo: { summonTaskRuntime: snapshot },
      }),
      queryWorkflow: vi.fn(),
      startScheduleWorkflow: vi.fn(),
    };
    const deps = createMockWebDeps({ workflows });
    const db = deps.db as unknown as {
      task: {
        findUnique: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
      };
      schedule: {
        findMany: ReturnType<typeof vi.fn>;
      };
    };

    db.task.findUnique.mockResolvedValue(buildTaskRecord({ isRoot: false, taskId: "task-child", tag: "task-child", temporalRunId: "run-1" }));
    db.task.update.mockResolvedValue(undefined);
    db.schedule.findMany.mockResolvedValue([]);

    await restartTask("agent-1", "task-child", undefined, deps);

    expect(workflows.startTaskWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-child",
        workflowId: "task-task-child",
        resumeInput: expect.objectContaining({
          previousRunId: "run-1",
          resumedFrom: expect.objectContaining({
            phase: "SLEEPING",
            turnNumber: 4,
          }),
        }),
      }),
    );
  });

  it("restart with an owner message atomically stops, inserts the message, and starts — without signalling", async () => {
    const snapshot = {
      schemaVersion: 1,
      taskId: "task-child",
      agentId: "agent-1",
      isRoot: false,
      phase: "ESCALATED",
      logicalStatus: "ESCALATED",
      turnNumber: 7,
      lastStopReason: "Blocked on external API",
      nextWakeAt: null,
      pendingEmailCount: 0,
      pendingOwnerCount: 0,
      pendingScheduleCount: 0,
    };
    let terminated = false;
    const workflows = {
      startTaskWorkflow: vi.fn().mockResolvedValue({ firstExecutionRunId: "run-fresh" }),
      terminateWorkflow: vi.fn().mockImplementation(async () => {
        terminated = true;
      }),
      signalWorkflow: vi.fn().mockResolvedValue(undefined),
      describeWorkflow: vi.fn().mockImplementation(async () => ({
        runId: "run-1",
        status: { name: terminated ? "TERMINATED" : "RUNNING" },
        memo: { summonTaskRuntime: snapshot },
      })),
      queryWorkflow: vi.fn(),
      startScheduleWorkflow: vi.fn(),
    };
    const deps = createMockWebDeps({ workflows });
    const db = deps.db as unknown as {
      task: {
        findUnique: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
      };
      conversation: {
        create: ReturnType<typeof vi.fn>;
      };
      schedule: {
        findMany: ReturnType<typeof vi.fn>;
      };
    };

    db.task.findUnique.mockResolvedValue(buildTaskRecord({ isRoot: false, taskId: "task-child", tag: "task-child", temporalRunId: "run-1" }));
    db.task.update.mockResolvedValue(undefined);
    db.conversation = { create: vi.fn().mockResolvedValue(undefined) };
    db.schedule.findMany.mockResolvedValue([]);

    await restartTask("agent-1", "task-child", "please retry the reply", deps);

    expect(workflows.terminateWorkflow).toHaveBeenCalledWith(
      "task-task-child",
      "Stopped from UI",
    );
    expect(db.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: "task-child",
          role: "user",
          message: expect.stringContaining("## INLINE OWNER MESSAGE"),
        }),
      }),
    );
    const insertedMessage = db.conversation.create.mock.calls[0][0].data.message as string;
    expect(insertedMessage).toContain("please retry the reply");
    expect(workflows.startTaskWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-child",
        workflowId: "task-task-child",
        resumeInput: expect.objectContaining({
          resumedFrom: expect.objectContaining({ phase: "ESCALATED" }),
        }),
      }),
    );

    // The whole point of the atomic endpoint: no SIGNAL_OWNER goes out, so the
    // new workflow's first turn is the ONLY turn that sees the message —
    // eliminating the restart-vs-wake race that produced duplicate side effects.
    expect(workflows.signalWorkflow).not.toHaveBeenCalled();

    // Order matters: terminate → conversation insert → startTaskWorkflow. If
    // the insert happened AFTER startTaskWorkflow, the new run's first turn
    // could read the conversation before the owner message is there.
    const terminateOrder = workflows.terminateWorkflow.mock.invocationCallOrder[0];
    const insertOrder = db.conversation.create.mock.invocationCallOrder[0];
    const startOrder = workflows.startTaskWorkflow.mock.invocationCallOrder[0];
    expect(terminateOrder).toBeLessThan(insertOrder);
    expect(insertOrder).toBeLessThan(startOrder);
  });

  it("restart with a whitespace-only message behaves like a plain restart", async () => {
    const snapshot = {
      schemaVersion: 1,
      taskId: "task-child",
      agentId: "agent-1",
      isRoot: false,
      phase: "SLEEPING",
      logicalStatus: "SLEEPING",
      turnNumber: 2,
      lastStopReason: null,
      nextWakeAt: null,
      pendingEmailCount: 0,
      pendingOwnerCount: 0,
      pendingScheduleCount: 0,
    };
    const workflows = {
      startTaskWorkflow: vi.fn().mockResolvedValue({ firstExecutionRunId: "run-plain" }),
      terminateWorkflow: vi.fn(),
      signalWorkflow: vi.fn(),
      describeWorkflow: vi.fn().mockResolvedValue({
        runId: "run-1",
        status: { name: "TERMINATED" },
        memo: { summonTaskRuntime: snapshot },
      }),
      queryWorkflow: vi.fn(),
      startScheduleWorkflow: vi.fn(),
    };
    const deps = createMockWebDeps({ workflows });
    const db = deps.db as unknown as {
      task: {
        findUnique: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
      };
      conversation: {
        create: ReturnType<typeof vi.fn>;
      };
      schedule: {
        findMany: ReturnType<typeof vi.fn>;
      };
    };

    db.task.findUnique.mockResolvedValue(buildTaskRecord({ isRoot: false, taskId: "task-child", tag: "task-child", temporalRunId: "run-1" }));
    db.task.update.mockResolvedValue(undefined);
    db.conversation = { create: vi.fn().mockResolvedValue(undefined) };
    db.schedule.findMany.mockResolvedValue([]);

    await restartTask("agent-1", "task-child", "   ", deps);

    expect(workflows.terminateWorkflow).not.toHaveBeenCalled();
    expect(db.conversation.create).not.toHaveBeenCalled();
    expect(workflows.signalWorkflow).not.toHaveBeenCalled();
    expect(workflows.startTaskWorkflow).toHaveBeenCalled();
  });

  it("signals direct owner wakes with structured inline payloads", async () => {
    const workflows = {
      startTaskWorkflow: vi.fn(),
      terminateWorkflow: vi.fn(),
      signalWorkflow: vi.fn().mockResolvedValue(undefined),
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
        turnNumber: 1,
        lastStopReason: "Waiting",
        nextWakeAt: null,
        pendingEmailCount: 0,
        pendingOwnerCount: 0,
        pendingScheduleCount: 0,
      }),
      startScheduleWorkflow: vi.fn(),
    };
    const deps = createMockWebDeps({ workflows });
    const db = deps.db as unknown as {
      task: {
        findFirst: ReturnType<typeof vi.fn>;
      };
      conversation: {
        create: ReturnType<typeof vi.fn>;
      };
    };

    db.task.findFirst = vi.fn().mockResolvedValue(buildTaskRecord({ isRoot: true, taskId: "task-root" }));
    db.conversation = { create: vi.fn().mockResolvedValue(undefined) };

    await wakeRootTask("agent-1", "Please follow up today", deps);

    expect(db.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: "task-root",
          message: expect.stringContaining("## INLINE OWNER MESSAGE"),
        }),
      }),
    );
    expect(workflows.signalWorkflow).toHaveBeenCalledWith(
      "agent__agent-1__root",
      "on_owner_response",
      expect.stringContaining('{"source":"owner","message":"Please follow up today"}'),
    );
  });
});
