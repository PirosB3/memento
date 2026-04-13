import { createLogger } from "@summon/shared";
import { restartTask } from "@/lib/server/task-services";

const log = createLogger("web:api:task-restart");

interface TaskRestartRouteContext {
  params: Promise<{
    id: string;
    taskId: string;
  }>;
}

export async function POST(
  _request: Request,
  { params }: TaskRestartRouteContext,
) {
  const { id, taskId } = await params;

  try {
    await restartTask(id, taskId);
    log.info(`Task restarted: ${taskId}`);
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restart task";
    const status = message === "Task not found" ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
