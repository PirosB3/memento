type TaskStatusLike = {
  status: string;
  workflowStatus: "RUNNING" | "STOPPED";
};

type MessageableTaskLike = TaskStatusLike & {
  isRoot: boolean;
};

export type TaskMessageAction = "wake" | "restart-with-message" | "disabled";

const MESSAGEABLE_STATUSES = new Set(["SLEEPING", "COMPLETED", "ESCALATED"]);

export function getStatusDot(status: string) {
  const map: Record<string, string> = {
    RUNNING: "status-dot-running",
    SLEEPING: "status-dot-sleeping",
    ESCALATED: "status-dot-escalated",
    COMPLETED: "status-dot-completed",
    STOPPED: "status-dot-completed",
    IDLE: "status-dot-idle",
  };
  return map[status] ?? "status-dot-idle";
}

export function getStatusBadgeVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "RUNNING" || status === "ESCALATED") return "default";
  if (status === "STOPPED") return "destructive";
  if (status === "COMPLETED") return "secondary";
  return "outline";
}

export function isStreamingStatus(status: string, workflowStatus: string): boolean {
  return workflowStatus === "RUNNING" && (status === "RUNNING" || status === "ESCALATED");
}

export function getDisplayedTaskStatus(task: TaskStatusLike): string {
  return task.workflowStatus === "STOPPED" ? "STOPPED" : task.status;
}

export function getTaskMessageAction(task: MessageableTaskLike): TaskMessageAction {
  if (!MESSAGEABLE_STATUSES.has(task.status)) {
    return "disabled";
  }

  if (task.workflowStatus === "RUNNING") {
    return "wake";
  }

  if (!task.isRoot) {
    return "restart-with-message";
  }

  return "disabled";
}
