import { getControlPlaneView } from "@/lib/server/control-plane-view";

interface ControlPlaneApiRouteProps {
  params: Promise<{
    agentId: string;
    taskKey: string;
  }>;
}

export async function GET(_request: Request, { params }: ControlPlaneApiRouteProps) {
  const { agentId, taskKey } = await params;
  const view = await getControlPlaneView(
    { agentId, taskKey },
    undefined,
    { fallbackToFirstAgent: false },
  );

  if (!view.selectedAgent) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }

  return Response.json(view);
}
