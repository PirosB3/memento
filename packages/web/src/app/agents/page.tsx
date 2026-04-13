import Link from "next/link";
import { getStoppedAwareAgentList } from "@/lib/server/workflow-control";


export const dynamic = "force-dynamic";

const agentColors = [
  "bg-blue-500", "bg-emerald-500", "bg-violet-500", "bg-rose-500",
  "bg-amber-500", "bg-cyan-500", "bg-pink-500", "bg-teal-500",
];

function getAgentColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return agentColors[Math.abs(hash) % agentColors.length];
}

function getStatusDotClass(status: string) {
  const map: Record<string, string> = {
    RUNNING: "status-dot-running",
    STOPPED: "status-dot-completed",
    IDLE: "status-dot-idle",
  };
  return map[status] ?? "status-dot-idle";
}

export default async function AgentsPage() {
  const agents = await getStoppedAwareAgentList();

  return (
    <div className="max-w-6xl mx-auto py-10 px-6">
      <div className="mb-10">
        <h1 className="font-[family-name:var(--font-outfit)] text-2xl font-bold tracking-tight mb-1">
          Agents
        </h1>
        <p className="text-sm text-[var(--muted-foreground)]">
          {agents.length} agent{agents.length !== 1 ? "s" : ""} deployed
        </p>
      </div>

      {agents.length === 0 ? (
        <div className="card p-16 text-center">
          <div className="w-12 h-12 rounded-xl bg-[var(--accent-muted)] flex items-center justify-center mx-auto mb-4">
            <span className="text-[var(--accent)] text-lg">+</span>
          </div>
          <p className="text-[var(--muted-foreground)] mb-1">No agents yet</p>
          <p className="text-sm text-[var(--muted)]">
            <Link href="/agents/new" className="text-[var(--accent)] hover:underline">
              Create your first agent
            </Link>{" "}
            to get started.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agents.map((agent) => {
            const childTasks = agent.tasks.filter((t) => !t.isRoot);
            const activeTasks = childTasks.filter((t) => t.status !== "COMPLETED");
            const hasActive = agent.tasks.some((t) => t.status === "RUNNING" || t.status === "ESCALATED");
            const derivedStatus = agent.workflowStatus === "STOPPED"
              ? "STOPPED"
              : hasActive
                ? "RUNNING"
                : "IDLE";
            const initial = agent.name.charAt(0).toUpperCase();

            return (
              <Link key={agent.agentId} href={`/agents/${agent.agentId}`} className="card p-5 block group">
                <div className="flex items-start gap-4">
                  <div className={`w-10 h-10 rounded-lg ${getAgentColor(agent.name)} flex items-center justify-center flex-shrink-0`}>
                    <span className="text-white font-[family-name:var(--font-outfit)] font-bold text-sm">{initial}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5 mb-1">
                      <h2 className="font-[family-name:var(--font-outfit)] font-semibold text-[var(--foreground)] group-hover:text-[var(--accent)] transition-colors truncate">
                        {agent.name}
                      </h2>
                      <span className={`status-dot ${getStatusDotClass(derivedStatus)}`} />
                      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
                        {derivedStatus}
                      </span>
                    </div>
                    <p className="font-mono text-xs text-[var(--muted-foreground)] mb-3 truncate">
                      {agent.agentEmail}
                    </p>
                    <div className="flex items-center gap-4 text-xs text-[var(--muted)]">
                      <span>
                        <span className="text-[var(--foreground)] font-medium">{activeTasks.length}</span> active
                        {" / "}
                        <span className="text-[var(--foreground)] font-medium">{childTasks.length}</span> total
                      </span>
                      <span>
                        Created {new Date(agent.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
