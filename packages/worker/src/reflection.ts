import { prisma, createLogger, getAgentsDir } from "@summon/shared";
import { completeSimple, getModel } from "../../../repos/pi-mono/packages/ai/dist/index.js";
import { loadCodexCredentials } from "./compaction.js";
import fs from "fs";
import path from "path";

const log = createLogger("reflection");
const AGENTS_DIR = getAgentsDir();

function reverseCopy<T>(items: T[]): T[] {
  const reversed: T[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    reversed.push(items[index]!);
  }
  return reversed;
}

const REFLECTION_SYSTEM_PROMPT = `You write short wake reflections for an AI email agent.

Return 2-4 concise sentences.
- State where the task stands right now.
- State what matters most about the new wake.
- State the next action to take.

Do not repeat the prompt verbatim. Do not invent facts beyond the supplied context.`;

const CHILD_REFLECTION_SYSTEM_PROMPT = `You write a structured reflection digest for a child task of an AI email agent.

Given the child task's recent activity, produce a compact markdown digest with these sections:
- **Material events** — what actually happened that matters
- **Successes** — what worked well
- **Frictions / uncertainties** — what went wrong or felt unclear
- **Candidate learnings for the root agent** — concrete, behavior-changing insights

Keep it to 6-10 bullets total across all sections. Be specific. Avoid vague platitudes.`;

export async function runReflectionImpl(
  taskId: string,
  _turnLogId: number,
  trigger: string,
  triggerContext: string,
  priorState: string,
  lastStopReason: string | null,
): Promise<string> {
  log.info(`Running reflection: task=${taskId} trigger=${trigger}`, {
    triggerContext,
    priorState,
    lastStopReason,
  });

  const task = await prisma.task.findUniqueOrThrow({
    where: { taskId },
  });

  const userPrompt = `## Task Objective
${task.objective}

## Prior State
${priorState}

## Last Stop Reason
${lastStopReason ?? "none"}

## Wake Trigger
Type: ${trigger}
Context: ${triggerContext}

Write a short wake reflection for the main turn.`;

  const creds = await loadCodexCredentials();
  const model = getModel("openai-codex" as never, "gpt-5.4" as never) as never;

  const response = await completeSimple(
    model,
    {
      systemPrompt: REFLECTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: userPrompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens: 256, apiKey: creds.access },
  );

  if ((response as { stopReason?: string }).stopReason === "error") {
    const errMsg = (response as { errorMessage?: string }).errorMessage ?? "unknown";
    log.error(`Reflection LLM errored: ${errMsg}`);
    return `(reflection unavailable: ${errMsg})`;
  }

  const content = (response as { content: Array<{ type: string; text?: string }> }).content;
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();

  log.info(`Reflection result: task=${taskId}`, { reflection: text });
  return text;
}

export async function runChildReflectionStepImpl(
  childTaskId: string,
): Promise<string> {
  log.info(`Running child reflection step: task=${childTaskId}`);

  const task = await prisma.task.findUniqueOrThrow({ where: { taskId: childTaskId } });

  const recentTurns = await prisma.agentTurnLog.findMany({
    where: { taskId: childTaskId },
    orderBy: { timestamp: "desc" },
    take: 10,
  });

  const recentMessages = await prisma.conversation.findMany({
    where: { taskId: childTaskId },
    orderBy: { id: "desc" },
    take: 30,
  });

  const turnSummary = reverseCopy(recentTurns)
    .map(
      (t) =>
        `  - turn ${t.turnNumber}: ${t.fromState}→${t.toState} trigger=${t.trigger} stopReason=${t.stopReason ?? "n/a"}`,
    )
    .join("\n");

  const conversationExcerpt = reverseCopy(recentMessages)
    .map((m) => {
      try {
        const parsed = JSON.parse(m.message);
        const raw = typeof parsed.content === "string" ? parsed.content : "";
        const preview = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
        return `[${parsed.role}] ${preview}`;
      } catch {
        const preview = m.message.length > 400 ? `${m.message.slice(0, 400)}…` : m.message;
        return `[${m.role}] ${preview}`;
      }
    })
    .join("\n");

  const userPrompt = `## Task
tag: ${task.tag}
objective: ${task.objective}
status: ${task.status}

## Recent Turns
${turnSummary || "(none)"}

## Recent Conversation (last ${recentMessages.length} messages)
${conversationExcerpt || "(none)"}

Write the reflection digest.`;

  const creds = await loadCodexCredentials();
  const model = getModel("openai-codex" as never, "gpt-5.4" as never) as never;

  const response = await completeSimple(
    model,
    {
      systemPrompt: CHILD_REFLECTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: userPrompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens: 800, apiKey: creds.access },
  );

  if ((response as { stopReason?: string }).stopReason === "error") {
    const errMsg = (response as { errorMessage?: string }).errorMessage ?? "unknown";
    throw new Error(`Child reflection LLM errored: ${errMsg}`);
  }

  const content = (response as { content: Array<{ type: string; text?: string }> }).content;
  const digest = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();

  if (!digest) {
    throw new Error("Child reflection LLM returned empty digest");
  }

  const notesDir = path.join(AGENTS_DIR, task.agentId, "tasks", task.tag);
  fs.mkdirSync(notesDir, { recursive: true });
  const notesPath = path.join(notesDir, "notes.md");
  const entry = `\n## Reflection ${new Date().toISOString()}\n\n${digest}\n`;
  fs.appendFileSync(notesPath, entry, "utf-8");

  log.info(`Child reflection appended: ${notesPath} (${digest.length} chars)`);
  return digest;
}
