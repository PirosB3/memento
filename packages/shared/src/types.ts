export type AgentStatus = "IDLE" | "RUNNING";

export type TaskStatus =
  | "RUNNING"
  | "SLEEPING"
  | "ESCALATED"
  | "COMPLETED";

export type WorkflowExecutionState = "RUNNING" | "STOPPED";

export type WakeSource =
  | "created"
  | "owner"
  | "email"
  | "schedule"
  | "sleep"
  | "root_task"
  | "restart";

export type TaskWorkflowPhase =
  | "CREATED"
  | "RUNNING"
  | "SLEEPING"
  | "ESCALATED"
  | "COMPLETED"
  | "DORMANT";

export interface TaskWorkflowRuntimeSnapshot {
  schemaVersion: 1;
  taskId: string;
  agentId: string;
  isRoot: boolean;
  phase: TaskWorkflowPhase;
  logicalStatus: TaskStatus;
  turnNumber: number;
  lastStopReason: string | null;
  nextWakeAt: string | null;
  lastReflectionAt?: string | null;
  pendingEmailCount: number;
  pendingOwnerCount: number;
  pendingScheduleCount: number;
}

export interface TaskWorkflowResumeInput {
  resumedFrom: TaskWorkflowRuntimeSnapshot | null;
  previousRunId: string | null;
  restartReason: string;
  restartedAt: string;
}

export interface ScheduleWorkflowRuntimeSnapshot {
  schemaVersion: 1;
  scheduleId: string;
  targetWorkflowId: string;
  fireAt: string;
  message: string;
  status: "PENDING" | "CANCELLED" | "FIRED";
}

export const TASK_QUEUE = "summon-agents";

// Signals for task workflows (root and child)
export const SIGNAL_EMAIL = "on_email";
export const SIGNAL_OWNER = "on_owner_response";
export const SIGNAL_SCHEDULE = "on_schedule";

// Queries for runtime inspection
export const QUERY_TASK_RUNTIME = "get_task_runtime";
export const QUERY_SCHEDULE_RUNTIME = "get_schedule_runtime";
export const TASK_RUNTIME_MEMO_KEY = "summonTaskRuntime";
export const SCHEDULE_RUNTIME_MEMO_KEY = "summonScheduleRuntime";

export interface InboundEmail {
  messageId: string;
  sender: string;
  inboxId: string;
  timestamp: string;
  tag?: string;
  batchMessageIds?: string[];
  batchSenders?: string[];
}

export interface DecisionResult {
  type: "sleep" | "defer" | "escalate" | "complete" | "fail";
  sleepDurationMs?: number;
  escalationQuestion?: string;
  summary?: string;
  error?: string;
  stopReason: string;
}

export interface TurnLogEntry {
  turnNumber: number;
  fromState: string;
  toState: string;
  trigger: string;
  wakeReflection: string | null;
  stopReason: string | null;
  timestamp: Date;
}

export interface TaskInfo {
  taskId: string;
  tag: string;
  taskEmail: string;
  objective: string;
  status: string;
}
