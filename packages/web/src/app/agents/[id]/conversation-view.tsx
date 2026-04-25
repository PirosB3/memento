"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownBody from "@/components/markdown-body";
import {
  buildDisplayBlocks,
  formatJson,
  matchBlock,
  stripAnsi,
  summarizeToolArgs,
  type ConversationRow,
  type DisplayBlock,
  type TurnLogRow,
} from "./lib/conversation";

const BASH_TRUNCATE = 2000;
const THINKING_PREVIEW_LIMIT = 160;

function formatTs(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function previewText(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit).trimEnd()}\u2026`;
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const q = needle.toLowerCase();
  const parts: Array<{ t: string; hit: boolean }> = [];
  let i = 0;
  const lower = text.toLowerCase();
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push({ t: text.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ t: text.slice(i, idx), hit: false });
    parts.push({ t: text.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return (
    <>
      {parts.map((p, k) =>
        p.hit ? (
          <mark
            key={k}
            className="bg-[rgba(249,115,22,0.35)] text-[var(--foreground)] rounded-sm px-0.5"
          >
            {p.t}
          </mark>
        ) : (
          <span key={k}>{p.t}</span>
        ),
      )}
    </>
  );
}

function ThinkingCard({
  block,
  needle,
}: {
  block: Extract<DisplayBlock, { kind: "thinking" }>;
  needle: string;
}) {
  const [open, setOpen] = useState(false);
  const preview = previewText(block.text, THINKING_PREVIEW_LIMIT);

  return (
    <div className="rounded-lg border border-blue-500/15 bg-blue-500/8 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-blue-500/8 transition-colors"
      >
        <span
          className={`transition-transform text-blue-300/80 text-[10px] ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          &#9654;
        </span>
        <span className="text-[10px] uppercase tracking-wider font-semibold text-blue-300">
          Thinking
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-blue-100/70">
          {needle ? <Highlight text={preview} needle={needle} /> : preview}
        </span>
        <span className="text-[10px] text-blue-100/50">{formatTs(block.timestamp)}</span>
      </button>

      {open && (
        <div className="border-t border-blue-500/10 px-3 py-2">
          {needle ? (
            <pre className="text-xs whitespace-pre-wrap font-sans text-blue-50/80 leading-relaxed">
              <Highlight text={block.text} needle={needle} />
            </pre>
          ) : (
            <MarkdownBody
              content={block.text}
              className="text-xs text-blue-50/80 leading-relaxed"
            />
          )}
        </div>
      )}
    </div>
  );
}

function BashOutput({ raw, needle }: { raw: string; needle: string }) {
  const [expanded, setExpanded] = useState(false);
  const cleaned = useMemo(() => stripAnsi(raw).replace(/\r/g, ""), [raw]);
  const tooLong = cleaned.length > BASH_TRUNCATE;
  const shown = expanded || !tooLong ? cleaned : cleaned.slice(0, BASH_TRUNCATE);

  return (
    <div className="rounded-md border border-[rgba(255,255,255,0.06)] bg-[#0b0b0f] overflow-hidden">
      <pre className="text-[11px] leading-relaxed text-[#d4d4d4] p-3 overflow-x-auto whitespace-pre-wrap font-mono max-h-[480px] overflow-y-auto">
        <Highlight text={shown} needle={needle} />
        {tooLong && !expanded && (
          <span className="text-muted-foreground/70">{"\n\u2026"}</span>
        )}
      </pre>
      {tooLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-left text-[10px] uppercase tracking-wider font-semibold text-muted-foreground hover:text-[var(--accent)] px-3 py-1.5 border-t border-[rgba(255,255,255,0.06)] transition-colors"
        >
          {expanded
            ? "Collapse output"
            : `Show full output (${cleaned.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

function ToolCallCard({
  block,
  needle,
}: {
  block: Extract<DisplayBlock, { kind: "toolPair" }>;
  needle: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarizeToolArgs(block.call.name, block.call.args);
  const argsJson = useMemo(() => formatJson(block.call.args), [block.call.args]);
  const hasResult = !!block.result;
  const timestamp = block.resultTimestamp ?? block.timestamp;

  return (
    <div className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[rgba(255,255,255,0.03)] transition-colors"
      >
        <span
          className={`transition-transform text-muted-foreground text-[10px] ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          &#9654;
        </span>
        <span className="text-[10px] uppercase tracking-wider font-semibold text-[var(--accent)]">
          {block.call.name}
        </span>
        {summary && (
          <span className="text-[11px] font-mono text-muted-foreground truncate flex-1">
            <Highlight text={summary} needle={needle} />
          </span>
        )}
        {!summary && <span className="flex-1" />}
        <span className="text-[10px] text-muted-foreground/60 ml-auto">
          {hasResult ? "call + result" : "call"}
        </span>
        <span className="text-[10px] text-muted-foreground/60">{formatTs(timestamp)}</span>
      </button>

      {open && (
        <div className="border-t border-[rgba(255,255,255,0.06)] p-3 space-y-3">
          <div>
            <div className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
              Arguments
            </div>
            <div className="rounded-md border border-[rgba(255,255,255,0.06)] bg-[#0b0b0f]">
              <pre className="text-[11px] leading-relaxed text-[#d4d4d4] p-3 overflow-x-auto whitespace-pre-wrap font-mono max-h-[320px] overflow-y-auto">
                <Highlight text={argsJson} needle={needle} />
              </pre>
            </div>
          </div>

          {block.result && (
            <div>
              <div className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
                Result
              </div>
              <BashOutput raw={block.result.output} needle={needle} />
            </div>
          )}

          {!block.result && (
            <div className="text-[10px] italic text-muted-foreground/60">
              No result recorded yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RoleMessage({
  block,
  needle,
}: {
  block: Extract<DisplayBlock, { kind: "role" }>;
  needle: string;
}) {
  const isAssistant = block.role === "assistant";
  return (
    <div
      className={`rounded-lg p-3 text-sm border ${
        isAssistant
          ? "bg-[var(--accent-muted)] border-[rgba(249,115,22,0.12)]"
          : "bg-muted/30 border-border"
      }`}
    >
      <div className="flex justify-between items-center mb-1.5">
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider ${
            isAssistant ? "text-primary" : "text-muted-foreground"
          }`}
        >
          {block.role}
        </span>
        <span className="text-[10px] text-muted-foreground">{formatTs(block.timestamp)}</span>
      </div>
      {needle ? (
        <pre className="text-sm whitespace-pre-wrap font-sans text-foreground/80 leading-relaxed">
          <Highlight text={block.text} needle={needle} />
        </pre>
      ) : (
        <MarkdownBody content={block.text} className="text-sm text-foreground/85 leading-relaxed" />
      )}
    </div>
  );
}

function TurnLogCard({ log, needle }: { log: TurnLogRow; needle: string }) {
  return (
    <div className="bg-muted/30 border border-border rounded-lg p-3 text-sm">
      <div className="flex gap-2 items-center mb-1 flex-wrap">
        <span className="font-mono text-xs text-foreground font-medium">#{log.turnNumber}</span>
        <span className="text-xs text-muted-foreground">
          {log.fromState} <span className="text-muted-foreground/50">&rarr;</span> {log.toState}
        </span>
        <span className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground/80 border border-border rounded px-1.5 py-0.5">
          {log.trigger}
        </span>
        <span className="text-[10px] text-muted-foreground ml-auto">{formatTs(log.timestamp)}</span>
      </div>
      {log.wakeReflection && (
        <div className="rounded p-2 mb-1 text-xs bg-blue-500/8 border border-blue-500/15">
          <span className="font-medium text-blue-400">Reflection: </span>
          <span className="text-blue-300/80">
            <Highlight text={log.wakeReflection} needle={needle} />
          </span>
        </div>
      )}
      {log.stopReason && (
        <div className="rounded p-2 text-xs bg-yellow-500/8 border border-yellow-500/15">
          <span className="font-medium text-yellow-400">Stop reason: </span>
          <span className="text-yellow-300/80">
            <Highlight text={log.stopReason} needle={needle} />
          </span>
        </div>
      )}
    </div>
  );
}

export default function ConversationView({
  conversations,
  turnLogs,
  isStreaming,
}: {
  conversations: ConversationRow[];
  turnLogs: TurnLogRow[];
  /** Show the pulsing "live" indicator when the task is RUNNING/ESCALATED. */
  isStreaming?: boolean;
}) {
  const [search, setSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef<boolean>(true);
  const lastCountRef = useRef<number>(conversations.length);
  const [pinned, setPinned] = useState(true);
  const [unread, setUnread] = useState(0);

  const blocks = useMemo(() => buildDisplayBlocks(conversations), [conversations]);
  const filteredBlocks = useMemo(
    () => (search ? blocks.filter((b) => matchBlock(b, search)) : blocks),
    [blocks, search],
  );

  const hiddenCount = blocks.length - filteredBlocks.length;

  // Track whether the user is pinned to the bottom of the scroll container.
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nowPinned = distance < 80;
    if (nowPinned !== pinnedRef.current) {
      pinnedRef.current = nowPinned;
      setPinned(nowPinned);
      if (nowPinned) setUnread(0);
    }
  }

  // Auto-scroll to bottom when new rows arrive, but only if pinned.
  // Otherwise bump the unread counter so the jump button shows how much was missed.
  useEffect(() => {
    const prev = lastCountRef.current;
    if (conversations.length !== prev) {
      const delta = conversations.length - prev;
      lastCountRef.current = conversations.length;
      if (pinnedRef.current) {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      } else if (delta > 0) {
        setUnread((u) => u + delta);
      }
    }
  }, [conversations.length]);

  // On first mount, pin to bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  function jumpToLatest() {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      pinnedRef.current = true;
      setPinned(true);
      setUnread(0);
    }
  }

  return (
    <div>
      {turnLogs.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Turn History
          </h3>
          <div className="space-y-2">
            {turnLogs.map((log) => (
              <TurnLogCard key={log.id} log={log} needle={search} />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Conversation
        </h3>
        {isStreaming && (
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--accent)]">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inset-0 rounded-full bg-[var(--accent)] opacity-60 animate-ping" />
              <span className="relative rounded-full h-1.5 w-1.5 bg-[var(--accent)]" />
            </span>
            live
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/60 ml-auto">
          {blocks.length} {blocks.length === 1 ? "message" : "messages"}
        </span>
      </div>

      <div className="relative mb-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search messages, tool args, output..."
          className="w-full bg-[rgba(255,255,255,0.02)] border border-[var(--border)] rounded-lg pl-8 pr-16 py-1.5 text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:border-[var(--accent)]/60 transition-colors"
        />
        <span
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 text-xs"
          aria-hidden
        >
          &#9906;
        </span>
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground hover:text-[var(--accent)] transition-colors"
          >
            clear
          </button>
        )}
      </div>
      {search && (
        <div className="text-[10px] text-muted-foreground mb-2 font-mono">
          {filteredBlocks.length} match{filteredBlocks.length === 1 ? "" : "es"}
          {hiddenCount > 0 && <> &middot; {hiddenCount} hidden</>}
        </div>
      )}

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="max-h-[560px] overflow-y-auto pr-1 space-y-2 rounded-lg border border-[rgba(255,255,255,0.04)] bg-[rgba(0,0,0,0.12)] p-2"
        >
          {filteredBlocks.length === 0 ? (
            <p className="text-xs text-muted-foreground p-4 text-center">
              {search ? "No messages match your search." : "No messages yet."}
            </p>
          ) : (
            filteredBlocks.map((block, i) => {
              if (block.kind === "role") {
                return (
                  <RoleMessage key={`${block.rowId}-${i}`} block={block} needle={search} />
                );
              }
              if (block.kind === "thinking") {
                return (
                  <ThinkingCard key={`${block.rowId}-${i}`} block={block} needle={search} />
                );
              }
              return (
                <ToolCallCard key={`${block.rowId}-${i}`} block={block} needle={search} />
              );
            })
          )}
        </div>

        {!search && !pinned && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-2 right-3 flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground bg-[#141419] hover:text-[var(--accent)] border border-[var(--border)] rounded-full pl-2.5 pr-2.5 py-1 shadow-md transition-colors"
          >
            {unread > 0 && (
              <span className="bg-[var(--accent)] text-black rounded-full px-1.5 py-0.5 text-[9px] leading-none font-bold normal-case tracking-normal">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
            <span>jump to latest &darr;</span>
          </button>
        )}
      </div>
    </div>
  );
}
