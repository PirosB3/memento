export const ROOT_TASK_KEY = "root";

export function controlPlanePath(agentId: string, taskKey: string = ROOT_TASK_KEY): string {
  return `/${encodeURIComponent(agentId)}/${encodeURIComponent(taskKey)}`;
}
