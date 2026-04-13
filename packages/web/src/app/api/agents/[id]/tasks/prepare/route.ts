import { prepareTask } from "@/lib/server/task-services";

interface PrepareTaskRouteContext {
  params: Promise<{
    id: string;
  }>;
}

export async function POST(
  request: Request,
  { params }: PrepareTaskRouteContext,
) {
  const { id } = await params;
  try {
    const { objective } = await request.json();
    const result = await prepareTask({ agentId: id, objective });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate questions";
    const status = message === "Agent not found" ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
