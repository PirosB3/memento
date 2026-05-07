"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  Plus,
  Search,
  Send,
  Wrench,
} from "lucide-react";
import MarkdownBody from "@/components/markdown-body";
import { Button, buttonVariants } from "@/components/ui/button";
import { controlPlanePath } from "@/lib/control-plane-paths";
import { cn } from "@/lib/utils";
import { getDisplayedTaskStatus, getStatusDot, getTaskMessageAction } from "@/lib/task-status";
import {
  buildDisplayBlocks,
  formatJson,
  stripAnsi,
  summarizeToolArgs,
  type DisplayBlock,
} from "@/lib/conversation";
import { mergeOverlay, useTurnStream } from "@/lib/use-turn-stream";
import ControlPlaneNewTaskForm from "./control-plane-new-task-form";
import type {
  ControlPlaneAgentSummaryView,
  ControlPlaneSelectedTaskView,
  ControlPlaneView,
} from "@/lib/view-models/control-plane";
import type { AgentView, TaskSummaryView } from "@/lib/view-models/task-view";

const POLL_INTERVAL_MS = 2000;
const TOOL_OUTPUT_LIMIT = 1600;
const AVATAR_GRADIENTS = [
  "from-blue-50 to-indigo-100 text-blue-700",
  "from-emerald-50 to-teal-100 text-emerald-700",
  "from-amber-50 to-orange-100 text-amber-800",
  "from-rose-50 to-pink-100 text-rose-700",
  "from-slate-50 to-zinc-100 text-slate-700",
];

function stableIndex(value: string, modulo: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = value.charCodeAt(index) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % modulo;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "A";
}

function formatTs(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function taskSubtitle(agentEmail: string, task: TaskSummaryView): string {
  if (task.isRoot) return agentEmail;
  return task.slug ?? task.tag;
}

function taskLabel(task: TaskSummaryView): string {
  return task.isRoot ? "Root Task" : task.objective.split("\n\nAdditional context:")[0] ?? task.objective;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}...`;
}

function displayMessageText(value: string): string {
  return value
    .replace(/^## INLINE OWNER MESSAGE\nSource: direct owner wake\n\n/, "")
    .trim();
}

function statusForAgent(agent: ControlPlaneAgentSummaryView): string {
  return agent.derivedStatus;
}

function statusPillClasses(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized === "RUNNING" || normalized === "ESCALATED") {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  if (normalized === "COMPLETED") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (normalized === "SLEEPING" || normalized === "IDLE") {
    return "border-slate-200 bg-slate-50 text-slate-600";
  }
  if (normalized === "STOPPED") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function StatusPill({
  status,
  quiet,
}: {
  status: string;
  quiet?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[10px] font-medium",
        statusPillClasses(status),
        quiet && "bg-white/70",
      )}
    >
      {status}
    </span>
  );
}

function AgentAvatar({
  name,
  src,
  className,
}: {
  name: string;
  src?: string | null;
  className?: string;
}) {
  const gradient = AVATAR_GRADIENTS[stableIndex(name, AVATAR_GRADIENTS.length)];
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-gradient-to-br text-xs font-semibold shadow-sm",
        gradient,
        className,
      )}
    >
      {src ? (
        <Image
          src={src}
          alt={`${name} avatar`}
          fill
          sizes="44px"
          className="object-cover"
          unoptimized
        />
      ) : (
        <span>{initials(name)}</span>
      )}
    </div>
  );
}

function ToolCallCard({
  block,
}: {
  block: Extract<DisplayBlock, { kind: "toolPair" }>;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarizeToolArgs(block.call.name, block.call.args);
  const resultText = block.result ? stripAnsi(block.result.output).replace(/\r/g, "") : "";
  const compactResult = resultText ? truncate(resultText.replace(/\s+/g, " ").trim(), 160) : "";
  const argsJson = useMemo(() => formatJson(block.call.args), [block.call.args]);
  const shownResult = open || resultText.length <= TOOL_OUTPUT_LIMIT
    ? resultText
    : `${resultText.slice(0, TOOL_OUTPUT_LIMIT).trimEnd()}\n...`;

  return (
    <div className="mx-auto flex w-full max-w-3xl justify-start">
      <div className="w-full rounded-lg border border-slate-200 bg-slate-50/80 shadow-sm">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/60"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <ChevronDown className="text-slate-500" />
          ) : (
            <ChevronRight className="text-slate-500" />
          )}
          <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
            <Wrench />
            Tool call
          </span>
          <span className="rounded-md border border-slate-200 bg-white px-2 py-0.5 font-mono text-xs text-slate-800">
            {block.call.name}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-500">
            {summary || compactResult || "No arguments"}
          </span>
          <StatusPill status={block.result ? "completed" : "running"} quiet />
        </button>

        {open && (
          <div className="flex flex-col gap-3 border-t border-slate-200 px-3 py-3">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">
                Arguments
              </div>
              <pre className="max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs leading-relaxed text-slate-800">
                {argsJson}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">
                Result
              </div>
              {block.result ? (
                <pre className="max-h-80 overflow-auto rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs leading-relaxed text-slate-800 whitespace-pre-wrap">
                  {shownResult || "Tool result recorded."}
                </pre>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-muted-foreground">
                  No result recorded yet.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingCard({
  block,
}: {
  block: Extract<DisplayBlock, { kind: "thinking" }>;
}) {
  const [open, setOpen] = useState(false);
  const preview = truncate(block.text.replace(/\s+/g, " ").trim(), 180);

  return (
    <div className="mx-auto flex w-full max-w-3xl justify-start">
      <div className="w-full rounded-lg border border-blue-100 bg-blue-50/70 shadow-sm">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/50"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <ChevronDown className="text-blue-500" />
          ) : (
            <ChevronRight className="text-blue-500" />
          )}
          <span className="text-xs font-medium uppercase text-blue-700">Thinking</span>
          <span className="min-w-0 flex-1 truncate text-xs text-blue-900/65">{preview}</span>
          <span className="text-[10px] text-blue-900/45">{formatTs(block.timestamp)}</span>
        </button>

        {open && (
          <div className="border-t border-blue-100 px-3 py-3">
            <MarkdownBody content={block.text} className="text-xs leading-relaxed text-blue-950/80" />
          </div>
        )}
      </div>
    </div>
  );
}

function RoleBubble({
  block,
  agent,
}: {
  block: Extract<DisplayBlock, { kind: "role" }>;
  agent: AgentView;
}) {
  const isOwner = block.role === "user" || block.role === "owner";
  const label = isOwner ? "Owner" : agent.name;
  const content = displayMessageText(block.text);

  return (
    <div className={cn("flex w-full gap-3", isOwner ? "justify-end" : "justify-start")}>
      {!isOwner && (
        <AgentAvatar name={agent.name} src={agent.profileImageUrl} className="mt-1 size-8" />
      )}
      <div
        className={cn(
          "max-w-[min(42rem,82%)] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm",
          isOwner
            ? "rounded-br-md bg-slate-100/90 text-slate-900"
            : "rounded-bl-md border border-border bg-white text-slate-900",
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase text-slate-400">
          <span>{label}</span>
          <span>{formatTs(block.timestamp)}</span>
        </div>
        <MarkdownBody content={content} className="text-sm leading-relaxed text-slate-900" />
      </div>
    </div>
  );
}

function ChatTranscript({
  agent,
  task,
}: {
  agent: AgentView;
  task: ControlPlaneSelectedTaskView;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef<boolean>(true);
  const lastCountRef = useRef<number>(0);
  const [pinned, setPinned] = useState(true);
  const [unread, setUnread] = useState(0);

  const { pendingOverlay } = useTurnStream(agent.agentId, task.detail.taskId);
  const merged = useMemo(
    () => mergeOverlay(task.detail.conversations, pendingOverlay),
    [task.detail.conversations, pendingOverlay],
  );
  const blocks = useMemo(() => buildDisplayBlocks(merged.conversations), [merged.conversations]);

  // When the task changes, snap to bottom and reset counters.
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
    setUnread(0);
    lastCountRef.current = blocks.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.key]);

  // Auto-scroll when new blocks arrive, but only if the user is pinned.
  // Otherwise bump the unread counter.
  useEffect(() => {
    const prev = lastCountRef.current;
    if (blocks.length === prev) return;
    const delta = blocks.length - prev;
    lastCountRef.current = blocks.length;
    if (pinnedRef.current) {
      const element = scrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    } else if (delta > 0) {
      setUnread((u) => u + delta);
    }
  }, [blocks.length]);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nowPinned = distance < 80;
    if (nowPinned !== pinnedRef.current) {
      pinnedRef.current = nowPinned;
      setPinned(nowPinned);
      if (nowPinned) setUnread(0);
    }
  }

  function jumpToLatest() {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
    setUnread(0);
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto px-4 py-7 md:px-10"
      >
        {blocks.length === 0 ? (
          <div className="mx-auto flex max-w-xl flex-col items-center justify-center gap-3 py-24 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border border-border bg-white">
              <Bot className="text-muted-foreground" />
            </div>
            <div className="text-sm font-medium text-foreground">No conversation yet</div>
            <p className="text-sm text-muted-foreground">
              Messages and tool calls for this task will appear here.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-5">
            {blocks.map((block, index) => (
              block.kind === "role" ? (
                <RoleBubble key={`${block.rowId}-${index}`} block={block} agent={agent} />
              ) : block.kind === "thinking" ? (
                <ThinkingCard key={`${block.rowId}-${index}`} block={block} />
              ) : (
                <ToolCallCard key={`${block.rowId}-${index}`} block={block} />
              )
            ))}
          </div>
        )}
      </div>
      {!pinned && blocks.length > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 right-6 flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-md transition-colors hover:border-slate-300 hover:text-slate-900"
        >
          {unread > 0 && (
            <span className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
          <span>Jump to latest ↓</span>
        </button>
      )}
    </div>
  );
}

function Composer({
  agentId,
  task,
  onSent,
}: {
  agentId: string;
  task: ControlPlaneSelectedTaskView;
  onSent: () => void;
}) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const messageAction = getTaskMessageAction(task.detail);
  const canSendMessage = messageAction !== "disabled";
  let taskKind: "root" | "child" = "child";
  if (task.detail.isRoot) {
    taskKind = "root";
  }
  const wakeEndpointByTaskKind: Record<typeof taskKind, string> = {
    root: `/api/agents/${agentId}/wake`,
    child: `/api/agents/${agentId}/tasks/${task.detail.taskId}/wake`,
  };
  const endpointByAction = {
    wake: wakeEndpointByTaskKind[taskKind],
    "restart-with-message": `/api/agents/${agentId}/tasks/${task.detail.taskId}/restart`,
    disabled: null,
  };
  const endpoint = endpointByAction[messageAction];
  const messageInputDisabled = !canSendMessage || pending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || !endpoint) return;

    setError(null);
    setPending(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? "Failed to send message.");
        return;
      }

      setMessage("");
      onSent();
    } catch {
      setError("Failed to send message.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border-t border-border bg-white px-4 py-4 md:px-10">
      <form onSubmit={handleSubmit} className="mx-auto max-w-4xl">
        <div className="flex min-h-14 items-end gap-2 rounded-2xl border border-border bg-white px-4 py-3 shadow-sm focus-within:border-ring">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={task.detail.isRoot ? "Message Root Task" : "Message Task"}
            disabled={messageInputDisabled}
            className="max-h-40 min-h-7 flex-1 resize-none border-0 bg-transparent text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            rows={1}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button
            type="submit"
            size="icon"
            className="rounded-full"
            disabled={messageInputDisabled || !message.trim()}
            aria-label="Send message"
          >
            <Send />
          </Button>
        </div>
        {!canSendMessage && (
          <p className="mt-2 text-xs text-muted-foreground">
            This task cannot receive owner messages in its current state.
          </p>
        )}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </form>
    </div>
  );
}

function CopyEmailButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="rounded-full text-slate-400 hover:text-slate-700"
      onClick={copyToClipboard}
      aria-label={`Copy ${value}`}
      title={copied ? "Copied" : "Copy email"}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

function TaskRow({
  task,
  selected,
  agentEmail,
  href,
}: {
  task: TaskSummaryView;
  selected: boolean;
  agentEmail: string;
  href: string;
}) {
  const status = getDisplayedTaskStatus(task);
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "group flex w-full items-start gap-2 rounded-lg px-2.5 py-2.5 text-left transition-colors",
        selected ? "bg-slate-100 text-foreground shadow-sm" : "text-slate-500 hover:bg-slate-50 hover:text-foreground",
      )}
    >
      <span className={cn("status-dot mt-1.5", getStatusDot(status))} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm", selected ? "font-semibold" : "font-medium")}>
          {taskLabel(task)}
        </span>
        <span className="block truncate font-mono text-[10px] text-muted-foreground">
          {taskSubtitle(agentEmail, task)}
        </span>
      </span>
      {selected ? <StatusPill status={status} /> : null}
    </Link>
  );
}

type ControlPlaneShellSelection = {
  agentId: string;
  taskKey: string;
};

export default function ControlPlaneShell({
  initialView,
  selection,
}: {
  initialView: ControlPlaneView;
  selection?: ControlPlaneShellSelection;
}) {
  const router = useRouter();
  const [view, setView] = useState(initialView);
  const [search, setSearch] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const fetchView = useCallback(async () => {
    if (!selection) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const response = await fetch(
      `/api/control-plane/${encodeURIComponent(selection.agentId)}/${encodeURIComponent(selection.taskKey)}`,
      {
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (response.ok) {
      setView(await response.json() as ControlPlaneView);
    }
  }, [selection]);

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled) return;
      try {
        await fetchView();
      } catch {
        // Ignore transient polling failures.
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [fetchView]);

  const selectedAgent = view.selectedAgent;
  const selectedTask = view.selectedTask;
  const rootTask = selectedAgent?.rootTask ?? null;
  const allTasks = useMemo(() => (
    selectedAgent && rootTask ? [rootTask, ...selectedAgent.tasks] : selectedAgent?.tasks ?? []
  ), [rootTask, selectedAgent]);

  const filteredTasks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle || !selectedAgent) return allTasks;
    return allTasks.filter((task) => (
      taskLabel(task).toLowerCase().includes(needle) ||
      taskSubtitle(selectedAgent.agentEmail, task).toLowerCase().includes(needle) ||
      getDisplayedTaskStatus(task).toLowerCase().includes(needle)
    ));
  }, [allTasks, search, selectedAgent]);

  const filteredAgents = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return view.agents;
    return view.agents.filter((agent) => (
      agent.name.toLowerCase().includes(needle) ||
      agent.agentEmail.toLowerCase().includes(needle) ||
      (
        selectedAgent?.agentId === agent.agentId &&
        allTasks.some((task) => (
          taskLabel(task).toLowerCase().includes(needle) ||
          taskSubtitle(selectedAgent.agentEmail, task).toLowerCase().includes(needle) ||
          getDisplayedTaskStatus(task).toLowerCase().includes(needle)
        ))
      )
    ));
  }, [allTasks, search, selectedAgent, view.agents]);

  function navigateToTask(agentId: string, taskKey: string) {
    router.push(controlPlanePath(agentId, taskKey), { scroll: false });
  }

  if (view.agents.length === 0) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-6">
        <div className="max-w-md rounded-lg border border-border bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <Bot className="text-muted-foreground" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">Memento Control Plane</h1>
          <p className="mt-2 text-sm text-muted-foreground">No agents have been created yet.</p>
          <Link href="/agents/new" className={buttonVariants({ className: "mt-5" })}>
            <Plus data-icon="inline-start" />
            New Agent
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground md:flex-row">
      <aside className="flex max-h-[46dvh] border-b border-border bg-slate-50 md:max-h-dvh md:w-[380px] md:flex-col md:border-b-0 md:border-r">
        <div className="flex w-full flex-col">
          <div className="flex items-center gap-3 border-b border-border px-4 py-4">
            <div className="flex size-9 items-center justify-center rounded-lg bg-foreground text-background">
              <Bot />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm font-semibold">Memento Control Plane</h1>
              <p className="text-xs text-muted-foreground">{view.agents.length} agents</p>
            </div>
            <Link
              href="/agents/new"
              className={buttonVariants({ size: "icon-sm" })}
              aria-label="Create agent"
            >
              <Plus />
            </Link>
          </div>

          <div className="border-b border-border p-3">
            <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-white px-3">
              <Search className="text-muted-foreground" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search agents"
                className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            <div className="mb-2 px-1 text-xs font-medium text-muted-foreground">Agents</div>
            <div className="flex flex-col gap-2">
              {filteredAgents.map((agent) => {
                const selected = selectedAgent?.agentId === agent.agentId;
                const status = statusForAgent(agent);
                return (
                  <div
                    key={agent.agentId}
                    className={cn(
                      "rounded-lg border border-transparent",
                      selected && "border-border bg-white shadow-sm",
                    )}
                  >
                    <Link
                      href={controlPlanePath(agent.agentId, "root")}
                      scroll={false}
                      aria-current={selected && selectedTask?.key === "root" ? "page" : undefined}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors",
                        selected ? "bg-white" : "hover:bg-white/80",
                      )}
                    >
                      <AgentAvatar name={agent.name} src={agent.profileImageUrl} className="size-10" />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{agent.name}</span>
                          <span className={cn("status-dot", getStatusDot(status))} />
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {agent.agentEmail}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {agent.taskCount} task{agent.taskCount === 1 ? "" : "s"}
                        </span>
                      </span>
                      {selected ? <ChevronDown className="text-muted-foreground" /> : <ChevronRight className="text-muted-foreground" />}
                    </Link>

                    {selectedAgent && selected && (
                      <div className="flex flex-col gap-2 border-t border-slate-100 px-2 py-2">
                        <ControlPlaneNewTaskForm
                          key={selectedAgent.agentId}
                          agentId={selectedAgent.agentId}
                          disabled={rootTask?.workflowStatus !== "RUNNING"}
                          onCreated={(taskId) => navigateToTask(selectedAgent.agentId, taskId)}
                        />
                        <div className="flex flex-col gap-1">
                          {filteredTasks.map((task) => (
                            <TaskRow
                              key={task.isRoot ? "root" : task.taskId}
                              task={task}
                              selected={selectedTask?.key === (task.isRoot ? "root" : task.taskId)}
                              agentEmail={selectedAgent.agentEmail}
                              href={controlPlanePath(selectedAgent.agentId, task.isRoot ? "root" : task.taskId)}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </aside>

      <main className="flex min-h-0 flex-1 flex-col bg-white">
        {selectedAgent && selectedTask ? (
          <>
            <header className="flex items-center gap-3 border-b border-border bg-white px-4 py-4 md:px-6">
              <AgentAvatar name={selectedAgent.name} src={selectedAgent.profileImageUrl} className="size-11" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="truncate text-lg font-semibold leading-6 text-foreground">
                    {truncate(selectedTask.title, 96)}
                  </h2>
                  <StatusPill status={getDisplayedTaskStatus(selectedTask.detail)} />
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span>{selectedAgent.name}</span>
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-mono">{selectedTask.email}</span>
                    <CopyEmailButton value={selectedTask.email} />
                  </span>
                  <span>{selectedTask.detail.conversations.length} messages</span>
                </div>
              </div>
            </header>
            <ChatTranscript agent={selectedAgent} task={selectedTask} />
            <Composer agentId={selectedAgent.agentId} task={selectedTask} onSent={fetchView} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select an agent to view its tasks.
          </div>
        )}
      </main>
    </div>
  );
}
