import { redirect } from "next/navigation";
import ControlPlaneShell from "./control-plane-shell";
import { controlPlanePath } from "@/lib/control-plane-paths";
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
    redirect(controlPlanePath(canonicalAgent, canonicalTask));
  }

  return <ControlPlaneShell initialView={view} />;
}
