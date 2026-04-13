import { createLogger } from "@summon/shared";
import { wakeTask } from "@/lib/server/task-services";

const log = createLogger("web:api:task-wake");

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await ctx.params;
  const body = await request.json().catch(() => null) as { message?: string } | null;
  const message = body?.message?.trim();

  if (!message) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  try {
    await wakeTask(id, taskId, message);
    return Response.json({ success: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail === "Task not found") {
      return Response.json({ error: detail }, { status: 404 });
    }

    log.error(`Failed to wake task ${taskId}:`, error);
    return Response.json({ error: "Failed to wake task" }, { status: 500 });
  }
}
