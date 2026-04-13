import { prepareAgent } from "@/lib/server/agent-services";

export async function POST(request: Request) {
  try {
    const { objective, ownerEmail } = await request.json();
    const result = await prepareAgent({ objective, ownerEmail });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to generate questions" },
      { status: 400 },
    );
  }
}
