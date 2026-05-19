import { describe, expect, it } from "vitest";
import {
  decodePiTurnDecision,
  encodePiTurnDecision,
  recoverDecisionFromMessages,
} from "./pi-turn-idempotency.js";

describe("pi-turn-idempotency", () => {
  it("round-trips encoded Pi turn decisions", () => {
    const decision = {
      type: "sleep" as const,
      stopReason: "Waiting for reply",
      sleepDurationMs: 60_000,
    };
    const encoded = encodePiTurnDecision(decision);
    expect(decodePiTurnDecision(encoded)).toEqual(decision);
  });

  it("recovers a decide tool call from persisted assistant messages", () => {
    const recovered = recoverDecisionFromMessages([
      {
        id: 1,
        role: "assistant",
        message: JSON.stringify({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "decide",
              arguments: {
                type: "complete",
                stopReason: "Done",
                summary: "Finished",
              },
            },
          ],
        }),
      },
    ]);

    expect(recovered).toEqual({
      type: "complete",
      stopReason: "Done",
      summary: "Finished",
    });
  });
});
