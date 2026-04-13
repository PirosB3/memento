import { createLogger } from "@summon/shared";
import { restartAgentWorkflows } from "@/lib/server/workflow-control";

const log = createLogger("web:api:agent-restart");

interface AgentRestartRouteContext {
  params: Promise<{
    id: string;
  }>;
}

export async function POST(
  _request: Request,
  { params }: AgentRestartRouteContext,
) {
  const { id } = await params;

  try {
    await restartAgentWorkflows(id);
    log.info(`Agent workflows restarted: ${id}`);
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restart agent";
    const status = message === "Root task not found" ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
