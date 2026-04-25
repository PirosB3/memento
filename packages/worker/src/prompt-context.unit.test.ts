import { describe, expect, it } from "vitest";
import type { Agent, Task } from "@prisma/client";
import { buildContextSeedMessage, buildWakeMessage } from "./prompt-context";

function buildAgentRecord() {
  return {
    agentId: "agent-1",
    name: "Avery",
    status: "RUNNING",
    temporalRunId: "run-1",
    createdAt: new Date(),
    ownerEmail: "owner@example.com",
    agentEmail: "avery@agentmail.test",
    soul: "Helpful and calm.",
    boundaries: "Escalate risky work.",
    tools: "Email and filesystem.",
    signatureDisplayName: null,
    signatureDescription: null,
    profileImageUrl: null,
  } as Agent;
}

function buildTaskRecord(input: { isRoot: boolean; tag: string; objective: string }) {
  return {
    taskId: "task-1",
    agentId: "agent-1",
    status: "RUNNING",
    parentTaskId: null,
    temporalRunId: "run-1",
    maxTurns: 25,
    timeoutHours: 24,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    completedAt: null,
    compactedPrefix: null,
    compactedSummary: null,
    compactedThroughId: null,
    ...input,
  } as Task;
}

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
      triggerContext: "Owner sent a message.",
      metadata: [{ label: "MESSAGE_ID", value: "msg-123" }],
      reflection: "The task was waiting on the owner and now has fresh direction.",
      todoSnapshot: "# TODO\n\n[ACTIONABLE]\n- Reply to Alice\n\n[BLOCKED]\n- none\n\n[DONE]\n- Drafted response",
      actionNow: "Use read_email with the MESSAGE_ID above to read the owner email, then act on it.",
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
    expect(message).toContain("## WHAT CHANGED");
    expect(message).toContain("Changed fields: soul, tools");
    expect(message).toContain("### UPDATED CONFIG SNAPSHOT");
    expect(message).toContain("## WAKE REFLECTION");
    expect(message).toContain("## TODO SNAPSHOT");
    expect(message).toContain("[ACTIONABLE]");
    expect(message).toContain("## ACTION NOW");
    // MESSAGE_ID lives in the metadata slot only — not duplicated in trigger
    // context or action-now prose.
    expect((message.match(/msg-123/g) ?? []).length).toBe(1);
  });

  it("omits the WHAT CHANGED section when the config has not changed", () => {
    const message = buildWakeMessage({
      wokenBy: "owner",
      priorState: "SLEEPING",
      lastStopReason: "Waiting for owner input",
      triggerContext: "Owner sent a message.",
      metadata: [{ label: "MESSAGE_ID", value: "msg-456" }],
      reflection: "Owner replied; resume.",
      actionNow: "Use read_email with the MESSAGE_ID above to read the owner email.",
      configChanged: false,
      configChangedFields: [],
    });

    expect(message).not.toContain("WHAT CHANGED");
    expect(message).not.toContain("Changed fields");
    expect(message).not.toContain("Config changed");
    // The non-config sections are still rendered.
    expect(message).toContain("## TRIGGER METADATA");
    expect(message).toContain("## WAKE REFLECTION");
    expect(message).toContain("## ACTION NOW");
  });
});
