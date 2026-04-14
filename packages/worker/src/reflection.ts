import { prisma, createLogger } from "@summon/shared";
import { completeSimple, getModel } from "../../../repos/pi-mono/packages/ai/dist/index.js";
import { loadCodexCredentials } from "./compaction.js";

const log = createLogger("reflection");

const REFLECTION_SYSTEM_PROMPT = `You write short wake reflections for an AI email agent.

Return 2-4 concise sentences.
- State where the task stands right now.
- State what matters most about the new wake.
- State the next action to take.

Do not repeat the prompt verbatim. Do not invent facts beyond the supplied context.`;

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
