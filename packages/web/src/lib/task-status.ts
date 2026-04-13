type TaskStatusLike = {
  status: string;
  workflowStatus: "RUNNING" | "STOPPED";
};

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
