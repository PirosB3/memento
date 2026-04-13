import { describe, expect, it } from "vitest";
import { buildAgentRecord, buildTaskRecord } from "../../../test/helpers/factories";
import { buildContextSeedMessage, buildWakeMessage } from "./prompt-context";

describe("prompt context helpers", () => {
  it("builds a context seed with task and config snapshot", () => {
    const agent = buildAgentRecord();
    const task = buildTaskRecord({ isRoot: false, tag: "abc123", objective: "Follow up with Alice" });

    const message = buildContextSeedMessage(agent, task);

    expect(message).toContain("## CONTEXT SEED");
    expect(message).toContain("AGENT NAME: Avery");
    expect(message).toContain("OWNER EMAIL: owner@example.com");
    expect(message).toContain("TASK EMAIL: avery+abc123@agentmail.test");
    expect(message).toContain("Follow up with Alice");
    expect(message).toContain("### SOUL");
  });

  it("builds a wake message with config deltas and reflection", () => {
    const message = buildWakeMessage({
      wokenBy: "owner",
      priorState: "SLEEPING",
      lastStopReason: "Waiting for owner input",
      triggerContext: "Owner sent a message (messageId=msg-123).",
      metadata: [{ label: "MESSAGE_ID", value: "msg-123" }],
      reflection: "The task was waiting on the owner and now has fresh direction.",
      todoSnapshot: "# TODO\n\n[ACTIONABLE]\n- Reply to Alice\n\n[BLOCKED]\n- none\n\n[DONE]\n- Drafted response",
      actionNow: 'Use read_email with messageId "msg-123" to read the owner email, then act on it.',
      configChanged: true,
      configChangedFields: ["soul", "tools"],
      configSnapshot: {
        soul: "Helpful and clear.",
        boundaries: "Escalate risky work.",
        tools: "Email and filesystem.",
      },
    });

    expect(message).toContain("WOKEN BY: owner");
    expect(message).toContain("PRIOR STATE: SLEEPING");
    expect(message).toContain("MESSAGE_ID: msg-123");
    expect(message).toContain("Config changed: yes");
    expect(message).toContain("Changed fields: soul, tools");
    expect(message).toContain("## WAKE REFLECTION");
    expect(message).toContain("## TODO SNAPSHOT");
    expect(message).toContain("[ACTIONABLE]");
    expect(message).toContain("## ACTION NOW");
  });
});
