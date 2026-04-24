import { redirect } from "next/navigation";
import ControlPlaneShell from "./control-plane-shell";
import { getControlPlaneView } from "@/lib/server/control-plane-view";

export const dynamic = "force-dynamic";

interface AgentsPageProps {
  searchParams: Promise<{
    agent?: string;
    task?: string;
  }>;
}

export default async function AgentsPage({ searchParams }: AgentsPageProps) {
  const params = await searchParams;
  const view = await getControlPlaneView({
    agentId: params.agent,
    taskKey: params.task,
  });

  if (view.selectedAgent && view.selectedTask) {
    const canonicalAgent = view.selectedAgent.agentId;
    const canonicalTask = view.selectedTask.key;
    if (params.agent !== canonicalAgent || params.task !== canonicalTask) {
      const canonicalParams = new URLSearchParams({
        agent: canonicalAgent,
        task: canonicalTask,
      });
      redirect(`/agents?${canonicalParams.toString()}`);
    }
  }

  return <ControlPlaneShell initialView={view} />;
}
