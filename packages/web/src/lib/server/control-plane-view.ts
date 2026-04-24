import { getAgentView } from "./agent-view";
import { getTaskView } from "./task-view";
import { getStoppedAwareAgentList } from "./workflow-control";
import { getWebServiceDependencies } from "./dependencies";
import type { WebServiceDependencies } from "./dependencies";
import type {
  ControlPlaneAgentSummaryView,
  ControlPlaneSelectedTaskView,
  ControlPlaneView,
} from "@/lib/view-models/control-plane";
import type { AgentView, TaskSummaryView } from "@/lib/view-models/task-view";

type ControlPlaneSelection = {
  agentId?: string | null;
  taskKey?: string | null;
};

function childAliasEmail(agentEmail: string, tag: string): string {
  const [local, domain] = agentEmail.split("@");
  if (!local || !domain) return agentEmail;
  return `${local}+${tag}@${domain}`;
}

function summarizeAgent(agent: Awaited<ReturnType<typeof getStoppedAwareAgentList>>[number]): ControlPlaneAgentSummaryView {
  const childTasks = agent.tasks.filter((task) => !task.isRoot);
  const hasActiveTask = agent.tasks.some(
    (task) => task.status === "RUNNING" || task.status === "ESCALATED",
  );
  const derivedStatus = agent.workflowStatus === "STOPPED"
    ? "STOPPED"
    : hasActiveTask
      ? "RUNNING"
      : "IDLE";

  return {
    agentId: agent.agentId,
    name: agent.name,
    agentEmail: agent.agentEmail,
    profileImageUrl: agent.profileImageUrl ?? null,
    workflowStatus: agent.workflowStatus,
    derivedStatus,
    taskCount: childTasks.length + (agent.tasks.some((task) => task.isRoot) ? 1 : 0),
    activeTaskCount: childTasks.filter((task) => task.status !== "COMPLETED").length,
    createdAt: agent.createdAt.toISOString(),
  };
}

function taskTitle(task: TaskSummaryView): string {
  return task.isRoot ? "Root Task" : task.objective.split("\n\nAdditional context:")[0] ?? task.objective;
}

function selectRootTask(agent: AgentView): ControlPlaneSelectedTaskView | null {
  if (!agent.rootTask) return null;
  return {
    key: "root",
    title: "Root Task",
    email: agent.agentEmail,
    detail: agent.rootTask,
  };
}

export async function getControlPlaneView(
  selection: ControlPlaneSelection = {},
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<ControlPlaneView> {
  const agentSummaries = await getStoppedAwareAgentList(deps);
  const agents = agentSummaries.map(summarizeAgent);

  if (agents.length === 0) {
    return {
      agents: [],
      selectedAgent: null,
      selectedTask: null,
    };
  }

  const selectedAgentId = agents.some((agent) => agent.agentId === selection.agentId)
    ? selection.agentId
    : agents[0]?.agentId;

  if (!selectedAgentId) {
    return {
      agents,
      selectedAgent: null,
      selectedTask: null,
    };
  }

  const selectedAgent = await getAgentView(selectedAgentId, deps) as AgentView | null;
  if (!selectedAgent) {
    return {
      agents,
      selectedAgent: null,
      selectedTask: null,
    };
  }

  const requestedTaskKey = selection.taskKey ?? "root";
  if (requestedTaskKey && requestedTaskKey !== "root") {
    const taskView = await getTaskView(selectedAgent.agentId, requestedTaskKey, deps);
    if (taskView) {
      return {
        agents,
        selectedAgent,
        selectedTask: {
          key: taskView.task.taskId,
          title: taskTitle(taskView.task),
          email: childAliasEmail(selectedAgent.agentEmail, taskView.task.tag),
          detail: taskView.task,
        },
      };
    }
  }

  return {
    agents,
    selectedAgent,
    selectedTask: selectRootTask(selectedAgent),
  };
}
