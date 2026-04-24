import type { AgentView, TaskDetailView } from "./task-view";

export type ControlPlaneAgentSummaryView = {
  agentId: string;
  name: string;
  agentEmail: string;
  profileImageUrl: string | null;
  workflowStatus: "RUNNING" | "STOPPED";
  derivedStatus: "RUNNING" | "IDLE" | "STOPPED";
  taskCount: number;
  activeTaskCount: number;
  createdAt: string;
};

export type ControlPlaneSelectedTaskView = {
  key: string;
  title: string;
  email: string;
  detail: TaskDetailView;
};

export type ControlPlaneView = {
  agents: ControlPlaneAgentSummaryView[];
  selectedAgent: AgentView | null;
  selectedTask: ControlPlaneSelectedTaskView | null;
};
