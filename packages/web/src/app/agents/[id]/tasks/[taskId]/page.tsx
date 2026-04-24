import { redirect } from "next/navigation";

interface TaskDetailPageProps {
  params: Promise<{
    id: string;
    taskId: string;
  }>;
}

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  const { id, taskId } = await params;
  redirect(`/agents?agent=${encodeURIComponent(id)}&task=${encodeURIComponent(taskId)}`);
}
