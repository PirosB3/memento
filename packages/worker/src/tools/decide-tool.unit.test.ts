import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { DecisionResult } from "@summon/shared";
import { createDecideTool } from "./decide-tool";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function createTodoFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decide-tool-"));
  tempDirs.push(dir);
  const todoPath = path.join(dir, "todo.md");
  fs.writeFileSync(todoPath, contents, "utf-8");
  return todoPath;
}

function getText(result: Awaited<ReturnType<ReturnType<typeof createDecideTool>["execute"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("decide tool", () => {
  it("allows sleep when actionable work is empty", async () => {
    const todoPath = createTodoFile(`# TODO

[ACTIONABLE]

[BLOCKED]
- Waiting on owner

[DONE]
- Replied`);
    let captured: DecisionResult | null = null;
    const tool = createDecideTool((decision) => {
      captured = decision;
    }, { todoFilePath: todoPath });

    const result = await tool.execute("call-1", {
      type: "sleep",
      stopReason: "Nothing actionable remains.",
      sleepDurationMs: 60_000,
    });

    expect(getText(result)).toContain("Decision recorded: sleep");
    expect(captured).toMatchObject({ type: "sleep" });
  });

  it("rejects sleep when actionable work remains", async () => {
    const todoPath = createTodoFile(`# TODO

[ACTIONABLE]
- Build cart

[BLOCKED]
- Waiting on owner

[DONE]
- Read the email`);
    let captured: DecisionResult | null = null;
    const tool = createDecideTool((decision) => {
      captured = decision;
    }, { todoFilePath: todoPath });

    const result = await tool.execute("call-2", {
      type: "sleep",
      stopReason: "Trying to sleep.",
      sleepDurationMs: 60_000,
    });

    expect(result.details).toEqual({ error: true, actionableCount: 1 });
    expect(getText(result)).toContain("There is still something actionable");
    expect(captured).toBeNull();
  });

  it("auto-defers on the third sleep attempt in the same turn", async () => {
    const todoPath = createTodoFile(`# TODO

[ACTIONABLE]
- Build cart

[BLOCKED]
- none

[DONE]
- Read the email`);
    let captured: DecisionResult | null = null;
    const tool = createDecideTool((decision) => {
      captured = decision;
    }, { todoFilePath: todoPath });

    await tool.execute("call-4", {
      type: "sleep",
      stopReason: "First try.",
      sleepDurationMs: 60_000,
    });
    await tool.execute("call-5", {
      type: "sleep",
      stopReason: "Second try.",
      sleepDurationMs: 60_000,
    });
    const result = await tool.execute("call-6", {
      type: "sleep",
      stopReason: "Third try.",
      sleepDurationMs: 60_000,
    });

    expect(getText(result)).toContain("Decision recorded: defer");
    expect(result.details).toMatchObject({ autoDeferred: true, type: "defer" });
    expect(captured).toMatchObject({ type: "defer" });
  });

  it("allows escalation when a marked owner email was sent", async () => {
    let captured: DecisionResult | null = null;
    const tool = createDecideTool((decision) => {
      captured = decision;
    }, { hasSentEscalationEmail: () => true });

    const result = await tool.execute("call-7", {
      type: "escalate",
      stopReason: "Asked the owner for missing context.",
      escalationQuestion: "Can you confirm the budget?",
    });

    expect(getText(result)).toContain("Decision recorded: escalate");
    expect(captured).toMatchObject({ type: "escalate" });
  });

  it("rejects escalation when no marked owner email was sent", async () => {
    let captured: DecisionResult | null = null;
    const tool = createDecideTool((decision) => {
      captured = decision;
    }, { hasSentEscalationEmail: () => false });

    const result = await tool.execute("call-8", {
      type: "escalate",
      stopReason: "Missing context.",
      escalationQuestion: "Can you confirm the budget?",
    });

    expect(result.details).toEqual({ error: true, missingActionRequiredEscalationEmail: true });
    expect(getText(result)).toContain("[ACTION REQUIRED]");
    expect(getText(result)).toContain("send a new email directly to the owner");
    expect(captured).toBeNull();
  });

  it("rejects root escalation when no marked owner email was sent", async () => {
    let captured: DecisionResult | null = null;
    const tool = createDecideTool((decision) => {
      captured = decision;
    }, { isRoot: true, hasSentEscalationEmail: () => false });

    const result = await tool.execute("call-9", {
      type: "escalate",
      stopReason: "Root needs owner input.",
      escalationQuestion: "Should I spawn a task for this?",
    });

    expect(result.details).toEqual({ error: true, missingActionRequiredEscalationEmail: true });
    expect(captured).toBeNull();
  });
});
