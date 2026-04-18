import type { ConversationRow, TurnLogRow } from "@/app/agents/[id]/lib/conversation";

export type TaskRuntimeSnapshotView = {
  phase: string;
  logicalStatus: string;
  turnNumber: number;
  lastStopReason: string | null;
  nextWakeAt: string | null;
};

export type TaskSummaryView = {
  taskId: string;
  agentId: string;
  tag: string;
  isRoot: boolean;
  objective: string;
  status: string;
  workflowStatus: "RUNNING" | "STOPPED";
  executionStatusName: string | null;
  runtimeSnapshot: TaskRuntimeSnapshotView | null;
  parentTaskId: string | null;
  createdAt: string;
};

export type TaskDetailView = TaskSummaryView & {
  conversations: ConversationRow[];
  turnLogs: TurnLogRow[];
};

export type AgentView = {
  agentId: string;
  name: string;
  agentEmail: string;
  ownerEmail: string;
  soul: string;
  boundaries: string;
  tools: string;
  signatureDisplayName: string | null;
  signatureDescription: string | null;
  profileImageUrl: string | null;
  rootTask: TaskDetailView | null;
  tasks: TaskSummaryView[];
};

export type TaskPageView = {
  agentId: string;
  agentName: string;
  agentEmail: string;
  ownerEmail: string;
  task: TaskDetailView;
};
