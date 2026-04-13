import { prisma, createLogger } from "@summon/shared";
import { createAgent } from "@/lib/server/agent-services";

const log = createLogger("web:api:agents");

export async function GET() {
  const agents = await prisma.agent.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      tasks: {
        select: { taskId: true, status: true },
      },
    },
  });
  return Response.json(agents);
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    log.info(`POST /api/agents raw body length: ${raw.length}`);
    const agent = await createAgent(JSON.parse(raw) as {
      ownerEmail: string;
      name: string;
      soul: string;
      boundaries: string;
      tools: string;
    });
    log.info(`Agent created: ${agent.agentId} email=${agent.agentEmail}`);
    return Response.json(agent, { status: 201 });
  } catch (error) {
    log.error("Failed to create agent:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to create agent" },
      { status: 400 },
    );
  }
}
