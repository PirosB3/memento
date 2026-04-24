"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownBody from "@/components/markdown-body";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import ConversationView from "../../conversation-view";
import WakeMessageForm from "../../wake-message-form";
import WorkflowActionButton from "../../workflow-action-button";
import { restartTaskAction, stopTaskAction } from "../../actions";
import { getLatestConversationPreview } from "../../lib/conversation";
import { mergeOverlay, useTurnStream } from "../../lib/use-turn-stream";
import { getDisplayedTaskStatus, getStatusBadgeVariant, getStatusDot, isStreamingStatus } from "@/lib/task-status";
import type { TaskPageView } from "@/lib/view-models/task-view";

const POLL_INTERVAL_MS = 2000;

function formatTs(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function buildAliasEmail(agentEmail: string, tag: string): string {
  const [local, domain] = agentEmail.split("@");
  return `${local}+${tag}@${domain}`;
}

export default function LiveTaskView({
  initialTaskView,
}: {
  initialTaskView: TaskPageView;
}) {
  const [taskView, setTaskView] = useState<TaskPageView>(initialTaskView);
  const [showFullObjective, setShowFullObjective] = useState(false);
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
        const response = await fetch(
          `/api/agents/${initialTaskView.agentId}/tasks/${initialTaskView.task.taskId}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );

        if (response.ok) {
          const data = (await response.json()) as TaskPageView;
          if (!cancelled) {
            setTaskView(data);
          }
        }
      } catch {
        // Ignore transient polling failures and retry on the next interval.
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
  }, [initialTaskView.agentId, initialTaskView.task.taskId]);

  const { agentEmail, agentName, task } = taskView;
  const displayedStatus = getDisplayedTaskStatus(task);
  const { pendingOverlay } = useTurnStream(taskView.agentId, task.taskId);
  const mergedConversations = useMemo(
    () => mergeOverlay(task.conversations, pendingOverlay),
    [task.conversations, pendingOverlay],
  );
  const isStreaming =
    mergedConversations.isStreaming ||
    isStreamingStatus(task.status, task.workflowStatus);
  const latestMessage = useMemo(
    () => getLatestConversationPreview(mergedConversations.conversations),
    [mergedConversations.conversations],
  );
  const aliasEmail = buildAliasEmail(agentEmail, task.tag);

  return (
    <>
      <div className="bg-card border border-border rounded-xl p-5 mb-6">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h1 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Latest Message
          </h1>
          <span className={`status-dot ${getStatusDot(displayedStatus)}`} />
          <Badge variant={getStatusBadgeVariant(displayedStatus)}>{displayedStatus}</Badge>
          {isStreaming && (
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--accent)]">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inset-0 rounded-full bg-[var(--accent)] opacity-60 animate-ping" />
                <span className="relative rounded-full h-1.5 w-1.5 bg-[var(--accent)]" />
              </span>
              live
            </span>
          )}
          {latestMessage && (
            <Badge variant="outline" className="text-[10px]">
              {latestMessage.label}
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto">
            {latestMessage ? formatTs(latestMessage.timestamp) : "No messages yet"}
          </span>
        </div>
        {latestMessage ? (
          latestMessage.kind === "role" ? (
            <div className="max-h-[18rem] overflow-y-auto pr-1">
              <MarkdownBody
                content={latestMessage.preview}
                className="text-sm text-foreground/85 leading-relaxed"
              />
            </div>
          ) : (
            <p className="text-sm text-foreground/85 whitespace-pre-wrap leading-relaxed">
              {latestMessage.preview}
            </p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            This task has not recorded any conversation messages yet.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span>
            <span className="text-muted-foreground/60">Task</span>{" "}
            <span className="font-mono text-foreground/80">+{task.tag.slice(0, 8)}</span>
          </span>
          <span>
            <span className="text-muted-foreground/60">Alias</span>{" "}
            <span className="font-mono text-foreground">{aliasEmail}</span>
          </span>
          {task.runtimeSnapshot?.nextWakeAt && (
            <span>
              <span className="text-muted-foreground/60">Next Wake</span>{" "}
              <span className="text-foreground/80">{formatTs(task.runtimeSnapshot.nextWakeAt)}</span>
            </span>
          )}
        </div>
      </div>

      {task.workflowStatus === "RUNNING" && (
        <div className="bg-card border border-border rounded-xl p-5 mb-6">
          <WakeMessageForm
            endpoint={`/api/agents/${taskView.agentId}/tasks/${task.taskId}/wake`}
            label="Wake task with message"
            placeholder="Send a direct wake message to this task..."
            failureMessage="Failed to wake task."
          />
        </div>
      )}

      <div className="bg-card border border-border rounded-xl p-6 mb-6">
        <div className="flex flex-wrap items-start gap-4 mb-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Task Details
              </h2>
            </div>
            <div className={showFullObjective ? "" : "relative max-h-[18rem] overflow-hidden"}>
              <MarkdownBody
                content={task.objective}
                className="text-base text-foreground/90 leading-relaxed"
              />
              {!showFullObjective && task.objective.length > 360 && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-[var(--card)] to-transparent" />
              )}
            </div>
            {task.objective.length > 360 && (
              <button
                type="button"
                onClick={() => setShowFullObjective((value) => !value)}
                className="mt-3 text-xs font-medium uppercase tracking-wider text-[var(--accent)] hover:brightness-110 transition-colors"
              >
                {showFullObjective ? "Show less" : "Show full objective"}
              </button>
            )}
            <p className="text-sm text-muted-foreground mt-3">
              {agentName} is handling this child task on its dedicated thread.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {task.workflowStatus === "STOPPED" ? (
              <WorkflowActionButton
                action={restartTaskAction.bind(null, taskView.agentId, task.taskId)}
                idleLabel="Restart"
                pendingLabel="Restarting..."
                className="text-xs font-medium text-emerald-400 hover:text-emerald-300 disabled:opacity-50 transition-colors"
              />
            ) : (
              <WorkflowActionButton
                action={stopTaskAction.bind(null, taskView.agentId, task.taskId)}
                confirmMessage="Stop this task workflow? This also stops its pending timers."
                idleLabel="Stop"
                pendingLabel="Stopping..."
                className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span>
            <span className="text-muted-foreground/60">Created</span>{" "}
            <span className="text-foreground/80">{new Date(task.createdAt).toLocaleString()}</span>
          </span>
          {task.parentTaskId && (
            <span>
              <span className="text-muted-foreground/60">Parent</span>{" "}
              <span className="font-mono text-foreground/80">{task.parentTaskId}</span>
            </span>
          )}
        </div>

        <Separator className="my-4 bg-border" />

        <div className="text-xs text-muted-foreground">
          {task.workflowStatus === "STOPPED"
            ? "This workflow is stopped. Restart it before sending a direct wake message."
            : task.runtimeSnapshot?.nextWakeAt
              ? `Next wake target: ${formatTs(task.runtimeSnapshot.nextWakeAt)}`
              : task.runtimeSnapshot?.lastStopReason
                ? `Last stop reason: ${task.runtimeSnapshot.lastStopReason}`
                : "Workflow is live and can receive direct wake messages."}
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-5">
        <ConversationView
          conversations={mergedConversations.conversations}
          turnLogs={task.turnLogs}
          isStreaming={isStreaming}
        />
      </div>
    </>
  );
}
