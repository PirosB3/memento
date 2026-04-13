import { generateAgentConfig } from "@/lib/server/agent-services";

export async function POST(request: Request) {
  try {
    const { objective, ownerEmail, answers } = await request.json();
    const result = await generateAgentConfig({ objective, ownerEmail, answers });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to generate config" },
      { status: 400 },
    );
  }
}
