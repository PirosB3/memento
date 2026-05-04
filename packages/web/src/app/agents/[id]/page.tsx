import { permanentRedirect } from "next/navigation";
import { controlPlanePath } from "@/lib/control-plane-paths";

interface AgentDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function AgentDetailPage({ params }: AgentDetailPageProps) {
  const { id } = await params;
  permanentRedirect(controlPlanePath(id, "root"));
}
