import { getControlPlaneView } from "@/lib/server/control-plane-view";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const view = await getControlPlaneView({
    agentId: url.searchParams.get("agent"),
    taskKey: url.searchParams.get("task"),
  });

  return Response.json(view);
}
