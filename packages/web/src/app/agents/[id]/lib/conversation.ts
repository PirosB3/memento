export type ConversationRow = {
  id: number;
  role: string;
  message: string;
  timestamp: string;
};

export type TurnLogRow = {
  id: number;
  turnNumber: number;
  fromState: string;
  toState: string;
  trigger: string;
  wakeReflection: string | null;
  stopReason: string | null;
  timestamp: string;
};

export type ParsedContent =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; id?: string; name: string; args: unknown }
  | { kind: "toolResult"; id?: string; name?: string; output: string }
  | { kind: "json"; value: unknown };

// ANSI escape sequences legitimately contain control characters — assemble
// the regex source from char codes so lint rules don't flag literal controls.
const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);
const BEL = String.fromCharCode(0x07);
const ANSI_RE = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?${BEL})|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
);

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractPlainText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item)) {
          if (typeof item.text === "string") return item.text;
          if (typeof item.output === "string") return item.output;
          if (typeof item.content === "string") return item.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(v)) {
    if (typeof v.text === "string") return v.text;
    if (typeof v.output === "string") return v.output;
    if (typeof v.content === "string") return v.content;
    return JSON.stringify(v, null, 2);
  }
  return String(v);
}

export function parseConversationMessage(raw: string): ParsedContent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [{ kind: "text", text: raw }];
  }

  // Top-level toolResult shape from Pi:
  // { role: "toolResult", toolCallId, toolName, content: [{type:"text",text}] }
  if (isRecord(parsed) && parsed.role === "toolResult") {
    return [
      {
        kind: "toolResult",
        id:
          typeof parsed.toolCallId === "string"
            ? parsed.toolCallId
            : typeof parsed.id === "string"
              ? parsed.id
              : undefined,
        name: typeof parsed.toolName === "string" ? parsed.toolName : undefined,
        output: extractPlainText(parsed.content ?? parsed.output ?? parsed.result ?? ""),
      },
    ];
  }

  // Pi message shape: { role, content: string | Array<{type, ...}> }
  const content = isRecord(parsed)
    ? (parsed as Record<string, unknown>).content ?? parsed
    : parsed;

  if (typeof content === "string") {
    return [{ kind: "text", text: content }];
  }

  if (Array.isArray(content)) {
    const out: ParsedContent[] = [];
    for (const part of content) {
      if (!isRecord(part)) {
        out.push({ kind: "text", text: String(part) });
        continue;
      }
      const type = part.type;
      if (type === "text" && typeof part.text === "string") {
        out.push({ kind: "text", text: part.text });
      } else if (type === "toolCall") {
        out.push({
          kind: "toolCall",
          id: typeof part.id === "string" ? part.id : undefined,
          name: typeof part.name === "string" ? part.name : "tool",
          args: part.arguments ?? part.args ?? part.input ?? {},
        });
      } else if (type === "toolResult") {
        out.push({
          kind: "toolResult",
          id:
            typeof part.toolCallId === "string"
              ? part.toolCallId
              : typeof part.id === "string"
                ? part.id
                : undefined,
          name: typeof part.name === "string" ? part.name : undefined,
          output: extractPlainText(part.output ?? part.content ?? part.result ?? ""),
        });
      } else {
        out.push({ kind: "json", value: part });
      }
    }
    return out;
  }

  return [{ kind: "json", value: content }];
}

export type DisplayBlock =
  | { kind: "role"; role: string; timestamp: string; text: string; rowId: number }
  | {
      kind: "toolPair";
      rowId: number;
      timestamp: string;
      resultTimestamp?: string;
      call: Extract<ParsedContent, { kind: "toolCall" }>;
      result?: Extract<ParsedContent, { kind: "toolResult" }>;
    };

export type LatestConversationPreview = {
  kind: "role" | "toolCall" | "toolResult";
  label: string;
  preview: string;
  timestamp: string;
};

const LATEST_PREVIEW_LIMIT = 280;

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, limit = LATEST_PREVIEW_LIMIT): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit).trimEnd()}\u2026`;
}

/**
 * Flatten conversation rows into display blocks, pairing each toolCall
 * with its corresponding toolResult (matched by id, else by arrival order).
 */
export function buildDisplayBlocks(rows: ConversationRow[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  const unresolvedCalls: Array<{ blockIndex: number; id?: string }> = [];

  for (const row of rows) {
    const parts = parseConversationMessage(row.message);
    const isToolRow = row.role === "tool" || row.role === "toolResult";

    if (isToolRow) {
      // This row carries tool results — attach them to earlier calls.
      for (const part of parts) {
        if (part.kind !== "toolResult") continue;
        let matchIdx = -1;
        if (part.id) {
          matchIdx = unresolvedCalls.findIndex((c) => c.id === part.id);
        }
        if (matchIdx === -1) {
          matchIdx = unresolvedCalls.findIndex((c) => !c.id);
        }
        if (matchIdx === -1) {
          matchIdx = 0;
        }
        const entry = unresolvedCalls[matchIdx];
        if (entry) {
          const target = blocks[entry.blockIndex];
          if (target && target.kind === "toolPair" && !target.result) {
            target.result = part;
            target.resultTimestamp = row.timestamp;
          }
          unresolvedCalls.splice(matchIdx, 1);
        } else {
          // Orphan result — render anyway.
          blocks.push({
            kind: "toolPair",
            rowId: row.id,
            timestamp: row.timestamp,
            resultTimestamp: row.timestamp,
            call: { kind: "toolCall", name: part.name ?? "tool", args: {} },
            result: part,
          });
        }
      }
      continue;
    }

    for (const part of parts) {
      if (part.kind === "text" && part.text.trim()) {
        blocks.push({
          kind: "role",
          role: row.role,
          timestamp: row.timestamp,
          text: part.text,
          rowId: row.id,
        });
      } else if (part.kind === "toolCall") {
        const blockIndex = blocks.length;
        blocks.push({
          kind: "toolPair",
          rowId: row.id,
          timestamp: row.timestamp,
          call: part,
        });
        unresolvedCalls.push({ blockIndex, id: part.id });
      } else if (part.kind === "json") {
        blocks.push({
          kind: "role",
          role: row.role,
          timestamp: row.timestamp,
          text: JSON.stringify(part.value, null, 2),
          rowId: row.id,
        });
      }
    }
  }

  return blocks;
}

export function summarizeToolArgs(name: string, args: unknown): string {
  if (!isRecord(args)) {
    if (typeof args === "string") return args.slice(0, 120);
    return "";
  }
  // Common, readable keys first
  const preferred = ["command", "cmd", "path", "file_path", "query", "message", "url", "content"];
  for (const key of preferred) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) {
      return `${key}: ${v.length > 140 ? v.slice(0, 140) + "\u2026" : v}`;
    }
  }
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  return keys.slice(0, 3).join(", ");
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function matchBlock(block: DisplayBlock, needle: string): boolean {
  if (!needle) return true;
  const q = needle.toLowerCase();
  if (block.kind === "role") {
    return block.text.toLowerCase().includes(q) || block.role.toLowerCase().includes(q);
  }
  const name = block.call.name.toLowerCase();
  if (name.includes(q)) return true;
  const argsStr = formatJson(block.call.args).toLowerCase();
  if (argsStr.includes(q)) return true;
  if (block.result) {
    return stripAnsi(block.result.output).toLowerCase().includes(q);
  }
  return false;
}

export function getLatestConversationPreview(
  rows: ConversationRow[],
): LatestConversationPreview | null {
  const latest = buildDisplayBlocks(rows).at(-1);

  if (!latest) {
    return null;
  }

  if (latest.kind === "role") {
    const preview = latest.text.trim();
    return {
      kind: "role",
      label: latest.role,
      preview: preview || "Message recorded.",
      timestamp: latest.timestamp,
    };
  }

  if (latest.result) {
    const toolName = latest.result.name ?? latest.call.name;
    const preview = truncateText(compactText(stripAnsi(latest.result.output)));
    return {
      kind: "toolResult",
      label: `${toolName} result`,
      preview: preview || "Tool result recorded.",
      timestamp: latest.resultTimestamp ?? latest.timestamp,
    };
  }

  const preview = truncateText(compactText(summarizeToolArgs(latest.call.name, latest.call.args)));
  return {
    kind: "toolCall",
    label: `${latest.call.name} call`,
    preview: preview || "Tool call started.",
    timestamp: latest.timestamp,
  };
}
