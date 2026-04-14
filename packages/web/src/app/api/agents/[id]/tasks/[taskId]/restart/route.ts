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
  request: Request,
  { params }: TaskRestartRouteContext,
) {
  const { id, taskId } = await params;
  const body = await request.json().catch(() => null) as { message?: string } | null;
  const ownerMessage = body?.message?.trim() || undefined;

  try {
    await restartTask(id, taskId, ownerMessage);
    log.info(`Task restarted${ownerMessage ? " with owner message" : ""}: ${taskId}`);
    return Response.json({ success: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Failed to restart task";
    const status = detail === "Task not found" ? 404 : 400;
    return Response.json({ error: detail }, { status });
  }
}
