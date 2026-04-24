import { notFound, redirect } from "next/navigation";
import ControlPlaneShell from "@/app/agents/control-plane-shell";
import { controlPlanePath } from "@/lib/control-plane-paths";
import { getControlPlaneView } from "@/lib/server/control-plane-view";

export const dynamic = "force-dynamic";

interface ControlPlaneTaskPageProps {
  params: Promise<{
    agentId: string;
    taskKey: string;
  }>;
}

export default async function ControlPlaneTaskPage({ params }: ControlPlaneTaskPageProps) {
  const { agentId, taskKey } = await params;
  const view = await getControlPlaneView(
    { agentId, taskKey },
    undefined,
    { fallbackToFirstAgent: false },
  );

  if (!view.selectedAgent) {
    notFound();
  }

  if (view.selectedTask && view.selectedTask.key !== taskKey) {
    redirect(controlPlanePath(view.selectedAgent.agentId, view.selectedTask.key));
  }

  return (
    <ControlPlaneShell
      initialView={view}
      selection={{ agentId: view.selectedAgent.agentId, taskKey: view.selectedTask?.key ?? "root" }}
    />
  );
}
