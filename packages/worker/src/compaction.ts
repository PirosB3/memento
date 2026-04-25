/**
 * Context compaction for long-running agent tasks.
 *
 * Strategy:
 *   1. Estimate token count of active conversation messages (chars/4 heuristic).
 *   2. When above threshold, compact via:
 *      a) OpenAI's /codex/responses/compact endpoint (if available on the ChatGPT backend), OR
 *      b) DIY summarization via gpt-5.5 as a fallback.
 *   3. Persist the result on the Task row so subsequent turns inject it as a prefix.
 *
 * The OpenAI compact endpoint returns *opaque* compaction items that can only be passed
 * back to OpenAI verbatim. We store them in task.compactedPrefix (Json) and prepend them
 * to each outgoing Responses request via the Agent's onPayload hook.
 *
 * The DIY path produces a plain-text summary that we store in task.compactedSummary
 * and inject as a leading user message.
 */

import fs from "node:fs";
import path from "node:path";
import { completeSimple, getModel } from "../../../repos/pi-mono/packages/ai/dist/index.js";
import { refreshOpenAICodexToken } from "../../../repos/pi-mono/packages/ai/dist/oauth.js";
import { prisma, createLogger } from "@summon/shared";
import type { AgentMessage } from "../pi-types.js";

const log = createLogger("compaction");

// ============================================================================
// Credentials
// ============================================================================

export interface CodexCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

function resolveCredentialsPath(): string {
  const override = process.env.SUMMON_CODEX_CREDENTIALS_PATH;
  if (override) return override;
  // Walk up from cwd looking for data/openai-codex-credentials.json
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "data", "openai-codex-credentials.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to cwd-relative; the caller will get a useful "not found" error
  return path.join(process.cwd(), "data", "openai-codex-credentials.json");
}

/**
 * Load ChatGPT OAuth credentials, refreshing them if expired.
 * Credentials file is rewritten in place when refreshed.
 */
export async function loadCodexCredentials(): Promise<CodexCredentials> {
  const credsPath = resolveCredentialsPath();
  if (!fs.existsSync(credsPath)) {
    throw new Error(
      `OpenAI Codex credentials not found at ${credsPath}. Run 'pnpm oauth:openai' first.`,
    );
  }
  const raw = fs.readFileSync(credsPath, "utf-8");
  const creds = JSON.parse(raw) as CodexCredentials;

  // Refresh if within 60s of expiry
  if (Date.now() >= creds.expires - 60_000) {
    log.info("Codex access token expired or near-expiry; refreshing");
    const refreshed = await refreshOpenAICodexToken(creds.refresh);
    fs.writeFileSync(credsPath, JSON.stringify(refreshed, null, 2) + "\n", { mode: 0o600 });
    return refreshed as unknown as CodexCredentials;
  }
  return creds;
}

// ============================================================================
// Token estimation (chars/4 heuristic, adapted from pi-mono coding-agent)
// ============================================================================

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += estimateMessageChars(msg);
  }
  return Math.ceil(chars / 4);
}

function estimateMessageChars(message: AgentMessage): number {
  let chars = 0;
  const m = message as { role: string; content?: unknown; command?: string; output?: string; summary?: string };
  switch (m.role) {
    case "user": {
      const c = m.content;
      if (typeof c === "string") chars += c.length;
      else if (Array.isArray(c)) {
        for (const block of c as Array<{ type?: string; text?: string }>) {
          if (block.type === "text" && block.text) chars += block.text.length;
        }
      }
      return chars;
    }
    case "assistant": {
      const content = m.content as Array<{
        type: string;
        text?: string;
        thinking?: string;
        name?: string;
        arguments?: unknown;
      }>;
      for (const block of content ?? []) {
        if (block.type === "text" && block.text) chars += block.text.length;
        else if (block.type === "thinking" && block.thinking) chars += block.thinking.length;
        else if (block.type === "toolCall") {
          chars += (block.name ?? "").length + JSON.stringify(block.arguments ?? {}).length;
        }
      }
      return chars;
    }
    case "toolResult":
    case "custom": {
      const c = m.content;
      if (typeof c === "string") chars += c.length;
      else if (Array.isArray(c)) {
        for (const block of c as Array<{ type?: string; text?: string }>) {
          if (block.type === "text" && block.text) chars += block.text.length;
          if (block.type === "image") chars += 4800; // rough image token estimate
        }
      }
      return chars;
    }
    case "bashExecution":
      return (m.command?.length ?? 0) + (m.output?.length ?? 0);
    case "branchSummary":
    case "compactionSummary":
      return (m.summary?.length ?? 0);
  }
  return 0;
}

// ============================================================================
// Summarization prompt (DIY fallback path)
// ============================================================================

const SUMMARIZATION_SYSTEM_PROMPT =
  "You summarize conversations to create structured context checkpoints. Be precise, preserve facts, and never fabricate information.";

const INITIAL_SUMMARIZATION_PROMPT = `The messages above are a conversation between an AI email agent and its environment (emails sent/received, tools called, decisions made). Create a structured checkpoint so another LLM can continue the work.

Use this EXACT format:

## Objective
[What is this task trying to accomplish?]

## People / Threads Involved
- [Name / email / role for each person or thread in scope]

## Progress
### Done
- [x] [Completed actions — emails sent, info gathered, decisions locked in]

### In Progress
- [ ] [Current work]

### Blocked / Waiting
- [Pending replies, approvals, info needed]

## Key Decisions
- **[Decision]**: [Rationale and who approved it]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Exact quotes, dates, times, addresses, links that must be preserved verbatim]
- [Or "(none)"]

Keep each section concise. Preserve exact email addresses, thread IDs, names, and dates.`;

const UPDATE_SUMMARIZATION_PROMPT = `Update the existing <previous-summary> with the NEW conversation messages above. RULES:
- PRESERVE all existing facts, names, email addresses, and decisions
- MOVE items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on new progress
- ADD new people / decisions / context discovered
- Remove items only if truly no longer relevant

Output the FULL updated summary in the same format as before.`;

// ============================================================================
// Compaction entry points
// ============================================================================

const CODEX_COMPACT_URL = "https://chatgpt.com/backend-api/codex/responses/compact";

export interface CompactTaskContextArgs {
  taskId: string;
  activeMessages: AgentMessage[];
  systemPrompt: string;
  tools: Array<{ name: string; description?: string; parameters?: unknown }>;
  mainModelId: string; // e.g. "gpt-5.5"
  credentials: CodexCredentials;
  existingCompactedPrefix: unknown;
  existingCompactedSummary: string | null;
  lastConversationId: number;
  tokensBefore: number;
  convertResponsesMessages: (
    model: { id: string; api: string; provider: string },
    context: { systemPrompt: string; messages: AgentMessage[]; tools: unknown[] },
    allowedToolCallProviders: ReadonlySet<string>,
    options?: { includeSystemPrompt?: boolean },
  ) => unknown[];
  responsesToolConverter: (tools: unknown[], options?: { strict?: boolean | null }) => unknown[];
  codexModelForConvert: { id: string; api: string; provider: string };
}

export type CompactionResult =
  | { mode: "prefix"; items: unknown[] }
  | { mode: "summary"; summary: string }
  | { mode: "skipped"; reason: string };

/**
 * Try the standalone /codex/responses/compact endpoint. Returns the compacted
 * ResponseInput items on success, or null if the endpoint is unavailable
 * (404/405) — caller should fall back to DIY summarization.
 * Throws on other HTTP errors.
 */
async function tryCodexCompactEndpoint(args: {
  input: unknown[];
  modelId: string;
  credentials: CodexCredentials;
}): Promise<unknown[] | null> {
  const res = await fetch(CODEX_COMPACT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.credentials.access}`,
      "chatgpt-account-id": args.credentials.accountId,
      "OpenAI-Beta": "responses=experimental",
    },
    body: JSON.stringify({ model: args.modelId, input: args.input }),
  });

  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return null; // endpoint not available on this backend
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`/codex/responses/compact failed: ${res.status} ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as { output?: unknown[] };
  if (!Array.isArray(json.output)) {
    throw new Error("/codex/responses/compact returned unexpected shape");
  }
  return json.output;
}

/**
 * DIY summarization fallback using gpt-5.5.
 */
async function summarizeViaFallbackModel(args: {
  activeMessages: AgentMessage[];
  previousSummary: string | null;
  credentials: CodexCredentials;
}): Promise<string> {
  const summarizerModel = getModel("openai-codex" as never, "gpt-5.5" as never) as unknown as {
    id: string;
    api: string;
    provider: string;
  };
  const basePrompt = args.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : INITIAL_SUMMARIZATION_PROMPT;

  // Render the conversation as plain text so the model doesn't try to continue it.
  const conversationText = serializeConversation(args.activeMessages);
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (args.previousSummary) {
    promptText += `<previous-summary>\n${args.previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  const response = await completeSimple(
    summarizerModel as never,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: promptText }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens: 4096, apiKey: args.credentials.access },
  );

  if ((response as { stopReason?: string }).stopReason === "error") {
    throw new Error(
      `Summarizer errored: ${(response as { errorMessage?: string }).errorMessage ?? "unknown"}`,
    );
  }

  const content = (response as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();
}

function serializeConversation(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const m of messages as Array<{ role: string; content?: unknown; command?: string; output?: string; summary?: string }>) {
    const role = m.role.toUpperCase();
    if (m.role === "assistant") {
      const blocks = (m.content as Array<{ type: string; text?: string; name?: string; arguments?: unknown }>) ?? [];
      for (const b of blocks) {
        if (b.type === "text" && b.text) lines.push(`[${role}] ${b.text}`);
        else if (b.type === "toolCall") lines.push(`[${role} calls ${b.name}] ${JSON.stringify(b.arguments ?? {}).slice(0, 500)}`);
      }
    } else if (m.role === "user" || m.role === "toolResult" || m.role === "custom") {
      const c = m.content;
      if (typeof c === "string") lines.push(`[${role}] ${c}`);
      else if (Array.isArray(c)) {
        for (const b of c as Array<{ type?: string; text?: string }>) {
          if (b.text) lines.push(`[${role}] ${b.text}`);
        }
      }
    } else if (m.role === "bashExecution") {
      lines.push(`[BASH] ${m.command}\n${(m.output ?? "").slice(0, 500)}`);
    } else if (m.role === "branchSummary" || m.role === "compactionSummary") {
      lines.push(`[SUMMARY] ${m.summary}`);
    }
  }
  return lines.join("\n");
}

/**
 * Compact the task context. Attempts the codex /compact endpoint first,
 * falls back to DIY summarization, and persists the result on the Task row.
 */
export async function compactTaskContext(args: CompactTaskContextArgs): Promise<CompactionResult> {
  const taskLog = log.child(`task:${args.taskId}`);

  // Build the Responses input from active messages using pi-mono's converter
  const responseInput = args.convertResponsesMessages(
    args.codexModelForConvert,
    { systemPrompt: args.systemPrompt, messages: args.activeMessages, tools: args.tools },
    new Set(["openai", "openai-codex", "opencode"]),
    { includeSystemPrompt: false },
  );

  // Attempt A: /codex/responses/compact, stacking on prior prefix
  const existingPrefix = Array.isArray(args.existingCompactedPrefix)
    ? (args.existingCompactedPrefix as unknown[])
    : [];
  const fullInput = [...existingPrefix, ...responseInput];

  try {
    const compactedOutput = await tryCodexCompactEndpoint({
      input: fullInput,
      modelId: args.mainModelId,
      credentials: args.credentials,
    });

    if (compactedOutput) {
      await prisma.task.update({
        where: { taskId: args.taskId },
        data: {
          compactedPrefix: compactedOutput as never,
          compactedSummary: null, // prefer prefix once available
          compactedThroughId: args.lastConversationId,
        },
      });
      taskLog.info(
        `Compacted via /codex/responses/compact: ${compactedOutput.length} items (was ${args.tokensBefore} est tokens)`,
      );
      return { mode: "prefix", items: compactedOutput };
    }

    taskLog.info("/codex/responses/compact not available on this backend; falling back to DIY summarization");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    taskLog.warn(`/codex/responses/compact errored, falling back to DIY: ${msg}`);
  }

  // Attempt B: DIY summarization via gpt-5.5
  try {
    const summary = await summarizeViaFallbackModel({
      activeMessages: args.activeMessages,
      previousSummary: args.existingCompactedSummary,
      credentials: args.credentials,
    });
    if (!summary) throw new Error("Summarizer returned empty text");

    await prisma.task.update({
      where: { taskId: args.taskId },
      data: {
        compactedSummary: summary,
        compactedPrefix: null as never, // if this path wins, drop any prior prefix
        compactedThroughId: args.lastConversationId,
      },
    });
    taskLog.info(
      `Compacted via DIY summarization: ${summary.length} chars (was ${args.tokensBefore} est tokens)`,
    );
    return { mode: "summary", summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    taskLog.error(`DIY summarization failed, skipping compaction this turn: ${msg}`);
    return { mode: "skipped", reason: msg };
  }
}
