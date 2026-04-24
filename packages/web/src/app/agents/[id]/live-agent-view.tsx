"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import NewTaskForm from "./new-task-form";
import WakeMessageForm from "./wake-message-form";
import WorkflowActionButton from "./workflow-action-button";
import {
  restartAgentAction,
  restartTaskAction,
  stopAgentAction,
  stopTaskAction,
} from "./actions";
import AgentTabs from "./agent-tabs";
import ConversationView from "./conversation-view";
import { getDisplayedTaskStatus, getStatusBadgeVariant, getStatusDot, isStreamingStatus } from "@/lib/task-status";
import type { AgentView } from "@/lib/view-models/task-view";
import { mergeOverlay, useTurnStream } from "./lib/use-turn-stream";

const POLL_INTERVAL_MS = 2000;

export default function LiveAgentView({
  initialAgent,
}: {
  initialAgent: AgentView;
}) {
  const [agent, setAgent] = useState<AgentView>(initialAgent);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/agents/${initialAgent.agentId}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as AgentView;
          if (!cancelled) setAgent(data);
        }
      } catch {
        // network error or aborted — swallow and retry
      } finally {
        if (!cancelled) {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
        }
      }
    }

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [initialAgent.agentId]);

  const rootTask = agent.rootTask;
  const rootTaskIdForStream = rootTask?.taskId ?? "";
  const { pendingOverlay: rootPendingOverlay } = useTurnStream(
    agent.agentId,
    rootTaskIdForStream,
  );
  const childTasks = agent.tasks;
  const rootWorkflowStatus = rootTask?.workflowStatus ?? "STOPPED";
  const allTasks = rootTask ? [rootTask, ...childTasks] : childTasks;
  const hasActiveTask = allTasks.some(
    (t) => t.workflowStatus === "RUNNING" && (t.status === "RUNNING" || t.status === "ESCALATED"),
  );
  const derivedStatus = rootWorkflowStatus === "STOPPED" ? "STOPPED" : hasActiveTask ? "RUNNING" : "IDLE";

  const signatureDisplayName = agent.signatureDisplayName ?? agent.name;
  const signatureDescription = agent.signatureDescription ?? "";

  const configContent = (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { label: "Soul", desc: "Personality & communication style", value: agent.soul },
          { label: "Boundaries", desc: "Constraints & escalation rules", value: agent.boundaries },
          { label: "Tools", desc: "Capabilities & access", value: agent.tools },
        ].map(({ label, desc, value }) => (
          <div key={label} className="bg-card border border-border rounded-xl p-4">
            <h3 className="text-sm font-semibold text-foreground mb-0.5">{label}</h3>
            <p className="text-[10px] text-muted-foreground mb-3">{desc}</p>
            <Separator className="mb-3 bg-border" />
            <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {value}
            </p>
          </div>
        ))}
      </div>
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-sm font-semibold text-foreground mb-0.5">Email Signature</h3>
        <p className="text-[10px] text-muted-foreground mb-3">Appended to every outbound email</p>
        <Separator className="mb-3 bg-border" />
        <div className="flex items-center gap-4">
          {agent.profileImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={agent.profileImageUrl}
              alt={`${signatureDisplayName} avatar`}
              className="w-16 h-16 rounded-2xl object-cover border border-border"
            />
          ) : (
            <div className="w-16 h-16 rounded-2xl bg-[var(--accent-muted)] border border-border flex items-center justify-center">
              <span className="text-[var(--accent)] text-xl font-bold">
                {signatureDisplayName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">{signatureDisplayName}</div>
            {signatureDescription ? (
              <div className="text-xs text-muted-foreground mt-0.5">{signatureDescription}</div>
            ) : (
              <div className="text-xs text-muted-foreground/60 italic mt-0.5">
                No description set — only the name will appear in the signature.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const rootContent = rootTask ? (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center gap-3 mb-4">
        <span className={`status-dot ${getStatusDot(getDisplayedTaskStatus(rootTask))}`} />
        <Badge variant={getStatusBadgeVariant(getDisplayedTaskStatus(rootTask))}>
          {getDisplayedTaskStatus(rootTask)}
        </Badge>
        <span className="text-sm font-medium">Main Thread</span>
        <span className="text-xs font-mono text-muted-foreground ml-auto">{agent.agentEmail}</span>
      </div>
      <Separator className="mb-4 bg-border" />
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="text-xs text-muted-foreground">
          {rootTask.workflowStatus === "STOPPED"
            ? "This workflow is stopped. Restart it before sending wakes."
            : rootTask.runtimeSnapshot?.nextWakeAt
              ? `Next wake target: ${new Date(rootTask.runtimeSnapshot.nextWakeAt).toLocaleString()}`
              : "Workflow is live and can be woken directly."}
        </div>
        {rootTask.workflowStatus === "STOPPED" ? (
          <WorkflowActionButton
            action={restartAgentAction.bind(null, agent.agentId)}
            idleLabel="Restart"
            pendingLabel="Restarting..."
            className="text-xs font-medium text-emerald-400 hover:text-emerald-300 disabled:opacity-50 transition-colors"
          />
        ) : (
          <WorkflowActionButton
            action={stopAgentAction.bind(null, agent.agentId)}
            confirmMessage="Stop this agent workflow? This also stops all child task workflows and pending timers."
            idleLabel="Stop"
            pendingLabel="Stopping..."
            className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
          />
        )}
      </div>
      {rootTask.workflowStatus === "RUNNING" && (
        <WakeMessageForm
          endpoint={`/api/agents/${agent.agentId}/wake`}
          label="Wake agent with message"
          placeholder="Tell the agent what to do right now..."
          failureMessage="Failed to wake agent."
        />
      )}
      {(() => {
        const merged = mergeOverlay(rootTask.conversations, rootPendingOverlay);
        return (
          <ConversationView
            conversations={merged.conversations}
            turnLogs={rootTask.turnLogs}
            isStreaming={
              merged.isStreaming ||
              isStreamingStatus(rootTask.status, rootTask.workflowStatus)
            }
          />
        );
      })()}
    </div>
  ) : (
    <p className="text-sm text-muted-foreground">No root task found.</p>
  );

  const tasksContent = (
    <div className="space-y-4">
      {rootWorkflowStatus === "RUNNING" ? (
        <NewTaskForm agentId={agent.agentId} />
      ) : (
        <div className="bg-card border border-border rounded-xl p-4 text-sm text-muted-foreground">
          Restart the main workflow before creating new child tasks.
        </div>
      )}

      {childTasks.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <p className="text-sm">No tasks yet. Create one above.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {childTasks.map((task) => {
            const streaming = isStreamingStatus(task.status, task.workflowStatus);
            const aliasEmail = `${agent.agentEmail.split("@")[0]}+${task.tag}@${agent.agentEmail.split("@")[1]}`;
            return (
              <div key={task.taskId} className="bg-card border border-border rounded-xl p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className={`status-dot ${getStatusDot(getDisplayedTaskStatus(task))}`} />
                    <Badge
                      variant={getStatusBadgeVariant(getDisplayedTaskStatus(task))}
                      className="text-[10px]"
                    >
                      {getDisplayedTaskStatus(task)}
                    </Badge>
                    {streaming && (
                      <span className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-[var(--accent)]">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inset-0 rounded-full bg-[var(--accent)] opacity-60 animate-ping" />
                          <span className="relative rounded-full h-1.5 w-1.5 bg-[var(--accent)]" />
                        </span>
                        live
                      </span>
                    )}
                    <span className="text-sm font-medium text-foreground flex-1 truncate">
                      {task.objective.length > 80
                        ? task.objective.slice(0, 80) + "..."
                        : task.objective}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 ml-auto">
                    <Link
                      href={`/agents/${agent.agentId}/tasks/${task.taskId}`}
                      className="text-[10px] font-medium uppercase tracking-wider text-[var(--accent)] hover:brightness-110 transition-colors"
                    >
                      Open task &rarr;
                    </Link>
                    {task.workflowStatus === "STOPPED" ? (
                      <WorkflowActionButton
                        action={restartTaskAction.bind(null, agent.agentId, task.taskId)}
                        idleLabel="Restart"
                        pendingLabel="Restarting..."
                        className="text-[10px] font-medium text-emerald-400 hover:text-emerald-300 disabled:opacity-50 transition-colors"
                      />
                    ) : (
                      <WorkflowActionButton
                        action={stopTaskAction.bind(null, agent.agentId, task.taskId)}
                        confirmMessage="Stop this task workflow? This also stops its pending timers."
                        idleLabel="Stop"
                        pendingLabel="Stopping..."
                        className="text-[10px] font-medium text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                      />
                    )}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Email: <span className="font-mono text-foreground/70">{aliasEmail}</span>
                  </span>
                  <span>
                    Created <span className="text-foreground/70">{new Date(task.createdAt).toLocaleDateString()}</span>
                  </span>
                  <span>
                    Tag <span className="font-mono text-foreground/70">+{task.tag.slice(0, 8)}</span>
                  </span>
                  {task.parentTaskId && (
                    <span>
                      Parent <span className="font-mono text-foreground/70">{task.parentTaskId.slice(0, 8)}...</span>
                    </span>
                  )}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {task.workflowStatus === "STOPPED"
                    ? "This workflow is stopped. Open the task page to restart it and review the thread."
                    : task.runtimeSnapshot?.nextWakeAt
                      ? `Next wake target: ${new Date(task.runtimeSnapshot.nextWakeAt).toLocaleString()}`
                      : task.runtimeSnapshot?.lastStopReason
                        ? `Last stop reason: ${task.runtimeSnapshot.lastStopReason}`
                        : "Open the task page to view the latest conversation and send direct wake messages."}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="bg-card border border-border rounded-xl p-6 mb-6">
        <div className="flex items-center gap-4 mb-3">
          {agent.profileImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={agent.profileImageUrl}
              alt={`${agent.name} avatar`}
              className="w-16 h-16 rounded-2xl object-cover border border-[var(--card-border)]"
            />
          ) : (
            <div className="w-16 h-16 rounded-2xl bg-[var(--accent-muted)] border border-[var(--card-border)] flex items-center justify-center">
              <span className="text-[var(--accent)] text-2xl font-[family-name:var(--font-outfit)] font-bold">
                {agent.name.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <h1 className="font-[family-name:var(--font-outfit)] text-2xl font-bold tracking-tight">
            {agent.name}
          </h1>
          <div className="flex items-center gap-2">
            <span className={`status-dot ${getStatusDot(derivedStatus)}`} />
            <Badge variant={getStatusBadgeVariant(derivedStatus)}>{derivedStatus}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="text-muted-foreground/60">Email</span>{" "}
            <span className="font-mono text-foreground">{agent.agentEmail}</span>
          </span>
          <span>
            <span className="text-muted-foreground/60">Owner</span>{" "}
            <span className="font-mono">{agent.ownerEmail}</span>
          </span>
          <span>
            <span className="text-muted-foreground/60">Tasks</span>{" "}
            <span className="text-foreground">{childTasks.length}</span>
          </span>
        </div>
      </div>

      <AgentTabs
        configContent={configContent}
        rootContent={rootContent}
        tasksContent={tasksContent}
        taskCount={childTasks.length}
      />
    </>
  );
}
