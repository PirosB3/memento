import { Type } from "@sinclair/typebox";
import type { DecisionResult } from "@summon/shared";
import type { AgentTool } from "../../pi-types.js";
import {
  TODO_AUTO_DEFER_MESSAGE,
  TODO_SLEEP_REJECTION_MESSAGE,
  readTodoSnapshot,
} from "../todo.js";

interface DecideToolOptions {
  isRoot?: boolean;
  todoFilePath?: string;
}

export function createDecideTool(
  onDecision: (decision: DecisionResult) => void,
  options: DecideToolOptions = {},
): AgentTool {
  const isRoot = options.isRoot ?? false;
  const types = isRoot
    ? [Type.Literal("sleep"), Type.Literal("escalate")]
    : [Type.Literal("sleep"), Type.Literal("escalate"), Type.Literal("complete"), Type.Literal("fail")];

  const typeDescription = isRoot
    ? `Types:
- "sleep": Go to sleep and wait for emails or a timer. Set sleepDurationMs.
- "escalate": Escalate to the owner. The platform emails the owner automatically with your escalationQuestion and stopReason — you do not need to send a separate email.

You are the root task — you cannot complete or fail. You are always on.`
    : `Types:
- "sleep": Go to sleep only when your TODO list has no actionable items left. Set sleepDurationMs. Only use this when you are waiting for something external (owner reply, timer, participant response).
- "escalate": Ask the owner for help. Use this the moment you are stuck, blocked by a broken tool path, or missing information only the owner can give you. The platform emails the owner automatically with your escalationQuestion and stopReason — you do not need to send a separate email.
- "complete": This task's objective is achieved. Provide a summary.
- "fail": **TERMINAL — only for objectives that are actually impossible.** The platform emails the owner automatically with your error and stopReason. Do NOT use fail for "I ran out of turn time" (use sleep with updated TODO) or "I'm confused about a tool" (use escalate). Once fail is called, the task cannot proceed without operator restart.`;

  let sleepAttemptCount = 0;

  return {
    name: "decide",
    label: "Decide",
    description: `Declare your decision for this turn. You MUST call this tool exactly once at the end of every turn.

${typeDescription}

Always include a stopReason explaining what you did this turn and why you chose this state.`,
    parameters: Type.Object({
      type: Type.Union(types as [typeof types[0], ...typeof types]),
      stopReason: Type.String({
        description: "Explanation of what you accomplished this turn and why you chose this next state",
      }),
      sleepDurationMs: Type.Optional(
        Type.Number({ description: "How long to wait in ms (default: 24 hours). Only for type=sleep." }),
      ),
      escalationQuestion: Type.Optional(
        Type.String({ description: "The question you asked the owner. Only for type=escalate." }),
      ),
      summary: Type.Optional(
        Type.String({ description: "Summary of what was accomplished. Only for type=complete." }),
      ),
      error: Type.Optional(
        Type.String({ description: "Error description. Only for type=fail." }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const p = params as Record<string, unknown>;

      // Block complete/fail for root
      if (isRoot && (p.type === "complete" || p.type === "fail")) {
        return {
          content: [{
            type: "text" as const,
            text: "You are the root task — you cannot complete or fail. Use 'sleep' or 'escalate' instead.",
          }],
          details: { error: true },
        };
      }

      if (!isRoot && p.type === "sleep") {
        sleepAttemptCount++;

        if (sleepAttemptCount >= 3) {
          const originalStopReason = p.stopReason as string;
          const decision: DecisionResult = {
            type: "defer",
            stopReason: `${TODO_AUTO_DEFER_MESSAGE} Original stop reason: ${originalStopReason}`,
            sleepDurationMs: p.sleepDurationMs as number | undefined,
          };
          onDecision(decision);
          return {
            content: [{
              type: "text" as const,
              text: `Decision recorded: defer. ${TODO_AUTO_DEFER_MESSAGE}`,
            }],
            details: { ...decision, autoDeferred: true },
          };
        }

        const todoState = options.todoFilePath
          ? readTodoSnapshot(options.todoFilePath)
          : { snapshot: null, actionableItems: [], isValid: false };

        if (!todoState.isValid || todoState.actionableItems.length > 0) {
          return {
            content: [{
              type: "text" as const,
              text: TODO_SLEEP_REJECTION_MESSAGE,
            }],
            details: { error: true, actionableCount: todoState.actionableItems.length },
          };
        }
      }

      const decision: DecisionResult = {
        type: p.type as DecisionResult["type"],
        stopReason: p.stopReason as string,
        sleepDurationMs: p.sleepDurationMs as number | undefined,
        escalationQuestion: p.escalationQuestion as string | undefined,
        summary: p.summary as string | undefined,
        error: p.error as string | undefined,
      };
      onDecision(decision);
      return {
        content: [{
          type: "text" as const,
          text: `Decision recorded: ${decision.type}. Stop reason: ${decision.stopReason}`,
        }],
        details: decision,
      };
    },
  };
}
