import { prisma } from "@summon/shared";
import type { DecisionResult } from "@summon/shared";

const PI_DONE_PREFIX = "__pi_done:";
const PI_PROGRESS_PREFIX = "__pi_progress:";

type ConversationRow = { id: number; role: string; message: string };

export function encodePiTurnDecision(decision: DecisionResult): string {
  return `${PI_DONE_PREFIX}${JSON.stringify(decision)}`;
}

export function decodePiTurnDecision(stopReason: string | null | undefined): DecisionResult | null {
  if (!stopReason?.startsWith(PI_DONE_PREFIX)) return null;
  try {
    return JSON.parse(stopReason.slice(PI_DONE_PREFIX.length)) as DecisionResult;
  } catch {
    return null;
  }
}

function parseProgressWatermark(stopReason: string | null | undefined): number | null {
  if (!stopReason?.startsWith(PI_PROGRESS_PREFIX)) return null;
  const value = Number.parseInt(stopReason.slice(PI_PROGRESS_PREFIX.length), 10);
  return Number.isFinite(value) ? value : null;
}

export async function markPiTurnProgress(turnLogId: number, conversationWatermarkId: number): Promise<void> {
  const turnLog = await prisma.agentTurnLog.findUniqueOrThrow({ where: { id: turnLogId } });
  if (turnLog.stopReason) return;
  await prisma.agentTurnLog.update({
    where: { id: turnLogId },
    data: { stopReason: `${PI_PROGRESS_PREFIX}${conversationWatermarkId}` },
  });
}

export async function finalizePiTurnDecision(turnLogId: number, decision: DecisionResult): Promise<void> {
  await prisma.agentTurnLog.update({
    where: { id: turnLogId },
    data: { stopReason: encodePiTurnDecision(decision) },
  });
}

export async function loadMaxConversationId(taskId: string): Promise<number> {
  const row = await prisma.conversation.findFirst({
    where: { taskId },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  return row?.id ?? 0;
}

export async function hasPiTurnAssistantOutput(
  taskId: string,
  watermarkConversationId: number,
): Promise<boolean> {
  const row = await prisma.conversation.findFirst({
    where: {
      taskId,
      id: { gt: watermarkConversationId },
      role: { in: ["assistant", "tool"] },
    },
    select: { id: true },
  });
  return row !== null;
}

export function recoverDecisionFromMessages(rows: ConversationRow[]): DecisionResult | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.role !== "assistant") continue;
    try {
      const parsed = JSON.parse(row.message) as { content?: unknown };
      if (!Array.isArray(parsed.content)) continue;
      for (const block of parsed.content) {
        if (!block || typeof block !== "object") continue;
        const candidate = block as { type?: string; name?: string; arguments?: unknown };
        if (candidate.type !== "toolCall" || candidate.name !== "decide") continue;
        const args = candidate.arguments;
        if (!args || typeof args !== "object") continue;
        const decision = args as Record<string, unknown>;
        const type = decision.type;
        if (typeof type !== "string" || typeof decision.stopReason !== "string") continue;
        return {
          type: type as DecisionResult["type"],
          stopReason: decision.stopReason,
          sleepDurationMs: typeof decision.sleepDurationMs === "number" ? decision.sleepDurationMs : undefined,
          escalationQuestion: typeof decision.escalationQuestion === "string"
            ? decision.escalationQuestion
            : undefined,
          summary: typeof decision.summary === "string" ? decision.summary : undefined,
          error: typeof decision.error === "string" ? decision.error : undefined,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function loadPiTurnResumeDecision(
  taskId: string,
  turnLogId: number,
): Promise<DecisionResult | null> {
  const turnLog = await prisma.agentTurnLog.findUniqueOrThrow({ where: { id: turnLogId } });
  const cached = decodePiTurnDecision(turnLog.stopReason);
  if (cached) return cached;

  const watermark = parseProgressWatermark(turnLog.stopReason);
  if (watermark === null) return null;

  const hasOutput = await hasPiTurnAssistantOutput(taskId, watermark);
  if (!hasOutput) return null;

  const rows = await prisma.conversation.findMany({
    where: { taskId, id: { gt: watermark } },
    orderBy: { id: "asc" },
    select: { id: true, role: true, message: true },
  });
  return recoverDecisionFromMessages(rows) ?? {
    type: "sleep",
    stopReason: "Pi turn output was persisted before the activity completed. Defaulting to sleep.",
    sleepDurationMs: 24 * 60 * 60 * 1000,
  };
}
