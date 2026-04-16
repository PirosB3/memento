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
    expect(captured?.type).toBe("sleep");
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
    expect(captured?.type).toBe("defer");
  });

  it("fail decision records type=fail with error, no TODO check required", async () => {
    let captured: DecisionResult | null = null;
    const tool = createDecideTool((decision) => {
      captured = decision;
    });

    const result = await tool.execute("call-fail", {
      type: "fail",
      stopReason: "Required API is permanently decommissioned.",
      error: "Vendor API returned 410 Gone for all requests.",
    });

    expect(getText(result)).toContain("Decision recorded: fail");
    expect(captured?.type).toBe("fail");
    expect(captured?.error).toBe("Vendor API returned 410 Gone for all requests.");
    expect(captured?.stopReason).toBe("Required API is permanently decommissioned.");
  });

  it("escalate decision records type=escalate with escalationQuestion", async () => {
    let captured: DecisionResult | null = null;
    const tool = createDecideTool((decision) => {
      captured = decision;
    });

    const result = await tool.execute("call-escalate", {
      type: "escalate",
      stopReason: "Cannot complete booking without a passenger name.",
      escalationQuestion: "What name should I put on the reservation?",
    });

    expect(getText(result)).toContain("Decision recorded: escalate");
    expect(captured?.type).toBe("escalate");
    expect(captured?.escalationQuestion).toBe("What name should I put on the reservation?");
  });

  it("root cannot call fail — receives error response and no decision emitted", async () => {
    let captured: DecisionResult | null = null;
    const tool = createDecideTool((decision) => {
      captured = decision;
    }, { isRoot: true });

    const result = await tool.execute("call-root-fail", {
      type: "fail",
      stopReason: "Trying to fail as root.",
      error: "This should not work.",
    });

    expect(getText(result)).toContain("cannot complete or fail");
    expect(result.details).toEqual({ error: true });
    expect(captured).toBeNull();
  });
});
