import Link from "next/link";
import { notFound } from "next/navigation";
import LiveTaskView from "./live-task-view";
import { getTaskView } from "@/lib/server/task-view";
import type { TaskPageView } from "@/lib/view-models/task-view";

export const dynamic = "force-dynamic";

interface TaskDetailPageProps {
  params: Promise<{
    id: string;
    taskId: string;
  }>;
}

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  const { id, taskId } = await params;
  const taskView = await getTaskView(id, taskId);

  if (!taskView) {
    notFound();
  }

  return (
    <div className="max-w-5xl mx-auto py-8 px-6">
      <Link
        href={`/agents/${id}`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <span>&larr;</span> Back to Agent
      </Link>

      <LiveTaskView initialTaskView={taskView as TaskPageView} />
    </div>
  );
}
