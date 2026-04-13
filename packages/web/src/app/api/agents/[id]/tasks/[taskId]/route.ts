import { createLogger } from "@summon/shared";
import { stopTask } from "@/lib/server/task-services";
import { getTaskView } from "@/lib/server/task-view";

const log = createLogger("web:api:tasks");

interface TaskRouteContext {
  params: Promise<{
    id: string;
    taskId: string;
  }>;
}

export async function DELETE(
  _request: Request,
  { params }: TaskRouteContext,
) {
  const { id, taskId } = await params;
  try {
    await stopTask(id, taskId);
    log.info(`Task stopped: ${taskId}`);
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to stop task";
    const status = message === "Task not found" ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}

export async function GET(
  _request: Request,
  { params }: TaskRouteContext,
) {
  const { id, taskId } = await params;
  const taskView = await getTaskView(id, taskId);

  if (!taskView) {
    return Response.json({ error: "Task not found" }, { status: 404 });
  }

  return Response.json(taskView);
}
