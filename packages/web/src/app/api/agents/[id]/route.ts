import { prisma } from "@summon/shared";
import { getAgentView } from "@/lib/server/agent-view";

interface AgentRouteContext {
  params: Promise<{
    id: string;
  }>;
}

export async function GET(
  _request: Request,
  { params }: AgentRouteContext,
) {
  const { id } = await params;
  const agent = await getAgentView(id);

  if (!agent) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }

  return Response.json(agent);
}

export async function PUT(
  request: Request,
  { params }: AgentRouteContext,
) {
  const { id } = await params;
  const { soul, boundaries, tools } = await request.json();

  const agent = await prisma.agent.findUnique({
    where: { agentId: id },
  });

  if (!agent) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }

  const updated = await prisma.agent.update({
    where: { agentId: id },
    data: {
      ...(soul !== undefined && { soul }),
      ...(boundaries !== undefined && { boundaries }),
      ...(tools !== undefined && { tools }),
    },
  });

  return Response.json(updated);
}
