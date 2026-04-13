import { notFound } from "next/navigation";
import Link from "next/link";
import LiveAgentView from "./live-agent-view";
import { getAgentView } from "@/lib/server/agent-view";
import type { AgentView } from "@/lib/view-models/task-view";

export const dynamic = "force-dynamic";

interface AgentDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function AgentDetailPage({ params }: AgentDetailPageProps) {
  const { id } = await params;

  const agent = await getAgentView(id);

  if (!agent) notFound();

  return (
    <div className="max-w-5xl mx-auto py-8 px-6">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <span>&larr;</span> All Agents
      </Link>

      <LiveAgentView initialAgent={agent as AgentView} />
    </div>
  );
}
