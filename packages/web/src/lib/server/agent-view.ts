import { getWebServiceDependencies } from "./dependencies";
import type { WebServiceDependencies } from "./dependencies";
import { serializeTaskDetail, serializeTaskSummary } from "./task-view";
import { getTaskWorkflowRuntime } from "./workflow-control";

export async function getAgentView(
  agentId: string,
  deps: WebServiceDependencies = getWebServiceDependencies(),
) {
  const [agent, tasks] = await Promise.all([
    deps.db.agent.findUnique({
      where: { agentId },
    }),
    deps.db.task.findMany({
      where: { agentId },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { agentmailThreadBindings: true } },
      },
    }),
  ]);

  if (!agent) {
    return null;
  }

  const taskRuntimes = await Promise.all(tasks.map((task) => getTaskWorkflowRuntime(task, deps)));
  const runtimeByTaskId = new Map(tasks.map((task, index) => [task.taskId, taskRuntimes[index]]));
  const rootTask = tasks.find((task) => task.isRoot) ?? null;
  const rootTaskDetail = rootTask
    ? await deps.db.task.findUnique({
        where: { taskId: rootTask.taskId },
        include: {
          _count: { select: { agentmailThreadBindings: true } },
          conversations: { orderBy: { id: "asc" } },
          turnLogs: { orderBy: { turnNumber: "asc" } },
        },
      })
    : null;

  return {
    agentId: agent.agentId,
    name: agent.name,
    agentEmail: agent.agentEmail,
    ownerEmail: agent.ownerEmail,
    soul: agent.soul,
    boundaries: agent.boundaries,
    tools: agent.tools,
    signatureDisplayName: agent.signatureDisplayName ?? null,
    signatureDescription: agent.signatureDescription ?? null,
    profileImageUrl: agent.profileImageUrl ?? null,
    rootTask: rootTask
      ? serializeTaskDetail(
          (rootTaskDetail ?? {
            ...rootTask,
            conversations: [],
            turnLogs: [],
          }),
          runtimeByTaskId.get(rootTask.taskId) ?? null,
        )
      : null,
    tasks: tasks
      .filter((task) => !task.isRoot)
      .map((task) => serializeTaskSummary(task, runtimeByTaskId.get(task.taskId) ?? null)),
  };
}
