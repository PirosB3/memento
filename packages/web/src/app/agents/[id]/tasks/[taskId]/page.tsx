import { redirect } from "next/navigation";
import { controlPlanePath } from "@/lib/control-plane-paths";

interface TaskDetailPageProps {
  params: Promise<{
    id: string;
    taskId: string;
  }>;
}

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  const { id, taskId } = await params;
  redirect(controlPlanePath(id, taskId));
}
