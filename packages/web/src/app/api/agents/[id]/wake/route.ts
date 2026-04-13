import { createLogger } from "@summon/shared";
import { wakeRootTask } from "@/lib/server/task-services";

const log = createLogger("web:api:agent-wake");

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await request.json().catch(() => null) as { message?: string } | null;
  const message = body?.message?.trim();

  if (!message) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  try {
    await wakeRootTask(id, message);
    return Response.json({ success: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail === "Root task not found") {
      return Response.json({ error: detail }, { status: 404 });
    }

    log.error(`Failed to wake root task for agent ${id}:`, error);
    return Response.json({ error: "Failed to wake agent" }, { status: 500 });
  }
}
