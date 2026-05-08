import { getWebServiceDependencies } from "./dependencies";
import type { WebServiceDependencies } from "./dependencies";
import { getTaskWorkflowRuntime } from "./workflow-control";
import type { TaskDetailView, TaskPageView, TaskRuntimeSnapshotView, TaskSummaryView } from "@/lib/view-models/task-view";

type TaskRecord = {
  taskId: string;
  agentId: string;
  tag: string;
  slug: string | null;
  _count?: { agentmailThreadBindings?: number };
  isRoot: boolean;
  objective: string;
  status: string;
  parentTaskId: string | null;
  createdAt: Date;
};

type ConversationRecord = {
  id: number;
  role: string;
  message: string;
  timestamp: Date;
  orderingKey: string;
};

type TurnLogRecord = {
  id: number;
  turnNumber: number;
  fromState: string;
  toState: string;
  trigger: string;
  wakeReflection: string | null;
  stopReason: string | null;
  timestamp: Date;
};

type TaskDetailRecord = TaskRecord & {
  conversations?: ConversationRecord[];
  turnLogs?: TurnLogRecord[];
  agent?: {
    agentId: string;
    name: string;
    agentEmail: string;
    ownerEmail: string;
  } | null;
};

type TaskRuntimeInfo = Awaited<ReturnType<typeof getTaskWorkflowRuntime>>;

function serializeRuntimeSnapshot(runtime: TaskRuntimeInfo["runtime"]): TaskRuntimeSnapshotView | null {
  if (!runtime) {
    return null;
  }

  return {
    phase: runtime.phase,
    logicalStatus: runtime.logicalStatus,
    turnNumber: runtime.turnNumber,
    lastStopReason: runtime.lastStopReason,
    nextWakeAt: runtime.nextWakeAt,
  };
}

function serializeTaskBase(
  task: TaskRecord,
  runtimeInfo: TaskRuntimeInfo | null,
): TaskSummaryView {
  return {
    taskId: task.taskId,
    agentId: task.agentId,
    tag: task.tag,
    slug: task.slug,
    agentmailThreadCount: task._count?.agentmailThreadBindings ?? 0,
    isRoot: task.isRoot,
    objective: task.objective,
    status: task.status,
    workflowStatus: runtimeInfo?.workflowStatus ?? "STOPPED",
    executionStatusName: runtimeInfo?.executionStatusName ?? null,
    runtimeSnapshot: serializeRuntimeSnapshot(runtimeInfo?.runtime ?? null),
    parentTaskId: task.parentTaskId,
    createdAt: task.createdAt.toISOString(),
  };
}

export function serializeTaskSummary(
  task: TaskRecord,
  runtimeInfo: TaskRuntimeInfo | null,
): TaskSummaryView {
  return serializeTaskBase(task, runtimeInfo);
}

export function serializeTaskDetail(
  task: TaskDetailRecord,
  runtimeInfo: TaskRuntimeInfo | null,
): TaskDetailView {
  return {
    ...serializeTaskBase(task, runtimeInfo),
    conversations: (task.conversations ?? []).map((conversation) => ({
      id: conversation.id,
      role: conversation.role,
      message: conversation.message,
      timestamp: conversation.timestamp.toISOString(),
      orderingKey: conversation.orderingKey,
    })),
    turnLogs: (task.turnLogs ?? []).map((log) => ({
      id: log.id,
      turnNumber: log.turnNumber,
      fromState: log.fromState,
      toState: log.toState,
      trigger: log.trigger,
      wakeReflection: log.wakeReflection,
      stopReason: log.stopReason,
      timestamp: log.timestamp.toISOString(),
    })),
  };
}

export async function getTaskView(
  agentId: string,
  taskId: string,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<TaskPageView | null> {
  const task = await deps.db.task.findUnique({
    where: { taskId },
    include: {
      _count: { select: { agentmailThreadBindings: true } },
      conversations: { orderBy: { id: "asc" } },
      turnLogs: { orderBy: { turnNumber: "asc" } },
      agent: {
        select: {
          agentId: true,
          name: true,
          agentEmail: true,
          ownerEmail: true,
        },
      },
    },
  }) as TaskDetailRecord | null;

  if (!task || task.agentId !== agentId || task.isRoot) {
    return null;
  }

  const runtimeInfo = await getTaskWorkflowRuntime(task, deps);
  const agent = task.agent ?? await deps.db.agent.findUnique({
    where: { agentId },
    select: {
      agentId: true,
      name: true,
      agentEmail: true,
      ownerEmail: true,
    },
  });

  if (!agent) {
    return null;
  }

  return {
    agentId: agent.agentId,
    agentName: agent.name,
    agentEmail: agent.agentEmail,
    ownerEmail: agent.ownerEmail,
    task: serializeTaskDetail(task, runtimeInfo),
  };
}
