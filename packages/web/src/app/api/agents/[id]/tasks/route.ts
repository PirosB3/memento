import { prisma, createLogger } from "@summon/shared";
import { createTask } from "@/lib/server/task-services";

const log = createLogger("web:api:tasks");

interface AgentTasksRouteContext {
  params: Promise<{
    id: string;
  }>;
}

export async function GET(
  _request: Request,
  { params }: AgentTasksRouteContext,
) {
  const { id } = await params;
  const tasks = await prisma.task.findMany({
    where: { agentId: id, isRoot: false },
    orderBy: { createdAt: "desc" },
  });
  return Response.json(tasks);
}

export async function POST(
  request: Request,
  { params }: AgentTasksRouteContext,
) {
  const { id } = await params;
  try {
    const { objective, answers } = await request.json();
    const task = await createTask({ agentId: id, objective, answers });
    log.info(`Task created: ${task.taskId} for agent ${id}`);
    return Response.json(task, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create task";
    const status = message === "Agent not found" ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
