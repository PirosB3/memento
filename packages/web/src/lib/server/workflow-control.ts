import {
  QUERY_TASK_RUNTIME,
  SCHEDULE_RUNTIME_MEMO_KEY,
  TASK_RUNTIME_MEMO_KEY,
  type ScheduleWorkflowRuntimeSnapshot,
  type TaskWorkflowResumeInput,
  type TaskWorkflowRuntimeSnapshot,
  type TaskStatus,
  type WorkflowExecutionState,
} from "@summon/shared";
import { getWebServiceDependencies } from "./dependencies";
import type { WebServiceDependencies } from "./dependencies";

type TaskIdentity = {
  taskId: string;
  agentId: string;
  isRoot: boolean;
};

type WorkflowTaskRecord = TaskIdentity & {
  status: string;
  temporalRunId: string | null;
};

type WorkflowDescription = {
  runId: string | null;
  statusName: string | null;
  memo: Record<string, unknown> | null;
};

type RuntimeInfo = {
  workflowStatus: WorkflowExecutionState;
  executionStatusName: string | null;
  runId: string | null;
  runtime: TaskWorkflowRuntimeSnapshot | null;
};

type ScheduleRuntimeInfo = {
  workflowStatus: WorkflowExecutionState;
  executionStatusName: string | null;
  runId: string | null;
  runtime: ScheduleWorkflowRuntimeSnapshot | null;
};

function rootWorkflowId(agentId: string): string {
  return `agent__${agentId}__root`;
}

export function taskWorkflowId(task: TaskIdentity): string {
  return task.isRoot ? rootWorkflowId(task.agentId) : `task-${task.taskId}`;
}

function scheduleWorkflowId(scheduleId: string): string {
  return `schedule-${scheduleId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseWorkflowDescription(input: unknown): WorkflowDescription | null {
  if (!isRecord(input)) return null;
  const status = isRecord(input.status) ? input.status : null;
  const memo = isRecord(input.memo) ? input.memo : null;
  return {
    runId: typeof input.runId === "string" ? input.runId : null,
    statusName: status && typeof status.name === "string" ? status.name : null,
    memo,
  };
}

function parseTaskRuntimeSnapshot(input: unknown): TaskWorkflowRuntimeSnapshot | null {
  if (!isRecord(input)) return null;
  return {
    schemaVersion: 1,
    taskId: typeof input.taskId === "string" ? input.taskId : "",
    agentId: typeof input.agentId === "string" ? input.agentId : "",
    isRoot: input.isRoot === true,
    phase: typeof input.phase === "string" ? input.phase as TaskWorkflowRuntimeSnapshot["phase"] : "CREATED",
    logicalStatus: typeof input.logicalStatus === "string"
      ? input.logicalStatus as TaskStatus
      : "RUNNING",
    turnNumber: typeof input.turnNumber === "number" ? input.turnNumber : 0,
    lastStopReason: typeof input.lastStopReason === "string" ? input.lastStopReason : null,
    nextWakeAt: typeof input.nextWakeAt === "string" ? input.nextWakeAt : null,
    pendingEmailCount: typeof input.pendingEmailCount === "number" ? input.pendingEmailCount : 0,
    pendingOwnerCount: typeof input.pendingOwnerCount === "number" ? input.pendingOwnerCount : 0,
    pendingScheduleCount: typeof input.pendingScheduleCount === "number" ? input.pendingScheduleCount : 0,
  };
}

function parseScheduleRuntimeSnapshot(input: unknown): ScheduleWorkflowRuntimeSnapshot | null {
  if (!isRecord(input)) return null;
  return {
    schemaVersion: 1,
    scheduleId: typeof input.scheduleId === "string" ? input.scheduleId : "",
    targetWorkflowId: typeof input.targetWorkflowId === "string" ? input.targetWorkflowId : "",
    fireAt: typeof input.fireAt === "string" ? input.fireAt : new Date(0).toISOString(),
    message: typeof input.message === "string" ? input.message : "",
    status: typeof input.status === "string"
      ? input.status as ScheduleWorkflowRuntimeSnapshot["status"]
      : "PENDING",
  };
}

function workflowStatusFromExecution(statusName: string | null): WorkflowExecutionState {
  return statusName === "RUNNING" ? "RUNNING" : "STOPPED";
}

async function describeWorkflow(
  workflowId: string,
  deps: WebServiceDependencies,
  runId?: string | null,
): Promise<WorkflowDescription | null> {
  try {
    return parseWorkflowDescription(
      await deps.workflows.describeWorkflow(workflowId, runId ?? undefined),
    );
  } catch {
    return null;
  }
}

async function readTaskRuntime(
  workflowId: string,
  description: WorkflowDescription | null,
  deps: WebServiceDependencies,
): Promise<TaskWorkflowRuntimeSnapshot | null> {
  if (!description) return null;

  if (description.statusName === "RUNNING") {
    try {
      return parseTaskRuntimeSnapshot(
        await deps.workflows.queryWorkflow<TaskWorkflowRuntimeSnapshot>(workflowId, QUERY_TASK_RUNTIME),
      );
    } catch {
      // Fall back to memo below.
    }
  }

  return parseTaskRuntimeSnapshot(description.memo?.[TASK_RUNTIME_MEMO_KEY]);
}

async function readScheduleRuntime(
  workflowId: string,
  description: WorkflowDescription | null,
): Promise<ScheduleWorkflowRuntimeSnapshot | null> {
  if (!description) return null;
  return parseScheduleRuntimeSnapshot(description.memo?.[SCHEDULE_RUNTIME_MEMO_KEY]);
}

async function latestTaskRuntime(
  task: TaskIdentity,
  deps: WebServiceDependencies,
): Promise<RuntimeInfo> {
  const workflowId = taskWorkflowId(task);
  const description = await describeWorkflow(workflowId, deps);
  const runtime = await readTaskRuntime(workflowId, description, deps);
  return {
    workflowStatus: workflowStatusFromExecution(description?.statusName ?? null),
    executionStatusName: description?.statusName ?? null,
    runId: description?.runId ?? null,
    runtime,
  };
}

async function latestScheduleRuntime(
  scheduleId: string,
  deps: WebServiceDependencies,
): Promise<ScheduleRuntimeInfo> {
  const workflowId = scheduleWorkflowId(scheduleId);
  const description = await describeWorkflow(workflowId, deps);
  const runtime = await readScheduleRuntime(workflowId, description);
  return {
    workflowStatus: workflowStatusFromExecution(description?.statusName ?? null),
    executionStatusName: description?.statusName ?? null,
    runId: description?.runId ?? null,
    runtime,
  };
}

async function fallbackResumeSnapshot(
  task: WorkflowTaskRecord,
  deps: WebServiceDependencies,
): Promise<TaskWorkflowRuntimeSnapshot> {
  const lastLog = await deps.db.agentTurnLog.findFirst({
    where: { taskId: task.taskId },
    orderBy: { turnNumber: "desc" },
  });

  const logicalStatus = task.status as TaskStatus;
  const phase = logicalStatus === "COMPLETED" ? "COMPLETED" : logicalStatus;

  return {
    schemaVersion: 1,
    taskId: task.taskId,
    agentId: task.agentId,
    isRoot: task.isRoot,
    phase,
    logicalStatus,
    turnNumber: lastLog?.turnNumber ?? 0,
    lastStopReason: lastLog?.stopReason ?? null,
    nextWakeAt: null,
    pendingEmailCount: 0,
    pendingOwnerCount: 0,
    pendingScheduleCount: 0,
  };
}

async function stopPendingSchedulesForTask(
  taskId: string,
  deps: WebServiceDependencies,
): Promise<void> {
  const schedules = await deps.db.schedule.findMany({
    where: { taskId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });

  await Promise.all(schedules.map(async (schedule) => {
    const info = await latestScheduleRuntime(schedule.scheduleId, deps);
    if (info.workflowStatus === "RUNNING") {
      await deps.workflows.terminateWorkflow(
        scheduleWorkflowId(schedule.scheduleId),
        "Stopped from UI",
      ).catch(() => undefined);
    }
  }));
}

async function restartPendingSchedulesForTask(
  taskId: string,
  deps: WebServiceDependencies,
): Promise<void> {
  const schedules = await deps.db.schedule.findMany({
    where: { taskId, status: "PENDING" },
    orderBy: { fireAt: "asc" },
  });

  await Promise.all(schedules.map(async (schedule) => {
    const info = await latestScheduleRuntime(schedule.scheduleId, deps);
    if (info.workflowStatus === "RUNNING") return;
    await deps.workflows.startScheduleWorkflow({
      scheduleId: schedule.scheduleId,
      targetWorkflowId: schedule.targetWorkflowId,
      fireAtMs: schedule.fireAt.getTime(),
      message: schedule.message,
    });
  }));
}

async function stopSingleTaskWorkflow(
  task: WorkflowTaskRecord,
  deps: WebServiceDependencies,
): Promise<void> {
  const workflowId = taskWorkflowId(task);
  const info = await latestTaskRuntime(task, deps);

  if (info.runId && info.runId !== task.temporalRunId) {
    await deps.db.task.update({
      where: { taskId: task.taskId },
      data: { temporalRunId: info.runId },
    });
  }

  if (info.workflowStatus === "RUNNING") {
    await deps.workflows.terminateWorkflow(workflowId, "Stopped from UI").catch(() => undefined);
  }
}

async function restartSingleTaskWorkflow(
  task: WorkflowTaskRecord,
  deps: WebServiceDependencies,
  restartReason: string,
): Promise<{ firstExecutionRunId: string }> {
  const workflowId = taskWorkflowId(task);
  const latest = await latestTaskRuntime(task, deps);
  if (latest.workflowStatus === "RUNNING") {
    throw new Error("Workflow is already running");
  }

  const recorded = task.temporalRunId
    ? await describeWorkflow(workflowId, deps, task.temporalRunId)
    : await describeWorkflow(workflowId, deps);

  const resumedFrom = parseTaskRuntimeSnapshot(recorded?.memo?.[TASK_RUNTIME_MEMO_KEY])
    ?? await fallbackResumeSnapshot(task, deps);

  const resumeInput: TaskWorkflowResumeInput = {
    resumedFrom,
    previousRunId: recorded?.runId ?? latest.runId ?? task.temporalRunId ?? null,
    restartReason,
    restartedAt: new Date().toISOString(),
  };

  const started = await deps.workflows.startTaskWorkflow({
    taskId: task.taskId,
    agentId: task.agentId,
    workflowId,
    resumeInput,
  });

  await deps.db.task.update({
    where: { taskId: task.taskId },
    data: { temporalRunId: started.firstExecutionRunId },
  });

  return started;
}

export async function stopTaskWorkflow(
  agentId: string,
  taskId: string,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<void> {
  const task = await deps.db.task.findUnique({ where: { taskId } });
  if (!task || task.agentId !== agentId || task.isRoot) {
    throw new Error("Task not found");
  }

  await stopPendingSchedulesForTask(task.taskId, deps);
  await stopSingleTaskWorkflow(task, deps);
}

export async function restartTaskWorkflow(
  agentId: string,
  taskId: string,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<void> {
  const task = await deps.db.task.findUnique({ where: { taskId } });
  if (!task || task.agentId !== agentId || task.isRoot) {
    throw new Error("Task not found");
  }

  await restartSingleTaskWorkflow(task, deps, "Restarted from UI");
  await restartPendingSchedulesForTask(task.taskId, deps);
}

export async function stopAgentWorkflows(
  agentId: string,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<void> {
  const tasks = await deps.db.task.findMany({
    where: { agentId },
    orderBy: [{ isRoot: "asc" }, { createdAt: "asc" }],
  });

  if (tasks.length === 0) {
    throw new Error("Agent not found");
  }

  const rootTask = tasks.find((task) => task.isRoot);
  if (!rootTask) {
    throw new Error("Root task not found");
  }

  await Promise.all(tasks.map(async (task) => {
    await stopPendingSchedulesForTask(task.taskId, deps);
    await stopSingleTaskWorkflow(task, deps);
  }));

  const rootRuntime = await latestTaskRuntime(rootTask, deps);
  if (rootRuntime.runId) {
    await deps.db.agent.update({
      where: { agentId },
      data: { temporalRunId: rootRuntime.runId },
    }).catch(() => undefined);
  }
}

export async function restartAgentWorkflows(
  agentId: string,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<void> {
  const rootTask = await deps.db.task.findFirst({
    where: { agentId, isRoot: true },
  });

  if (!rootTask) {
    throw new Error("Root task not found");
  }

  const started = await restartSingleTaskWorkflow(rootTask, deps, "Agent workflow restarted from UI");
  await deps.db.agent.update({
    where: { agentId },
    data: { temporalRunId: started.firstExecutionRunId },
  }).catch(() => undefined);
  await restartPendingSchedulesForTask(rootTask.taskId, deps);
}

export async function getTaskWorkflowRuntime(
  task: TaskIdentity,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<RuntimeInfo> {
  return latestTaskRuntime(task, deps);
}

export async function getStoppedAwareAgentList(
  deps: WebServiceDependencies = getWebServiceDependencies(),
) {
  const agents = await deps.db.agent.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      tasks: {
        select: { taskId: true, agentId: true, status: true, isRoot: true },
      },
    },
  });

  const rootStatuses = await Promise.all(agents.map(async (agent) => {
    const rootTask = agent.tasks.find((task) => task.isRoot);
    if (!rootTask) return "STOPPED" as WorkflowExecutionState;
    return (await latestTaskRuntime(rootTask, deps)).workflowStatus;
  }));

  return agents.map((agent, index) => ({
    ...agent,
    workflowStatus: rootStatuses[index],
  }));
}
