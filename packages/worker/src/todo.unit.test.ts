import { describe, expect, it } from "vitest";
import {
  buildCappedTodoSnapshot,
  buildMissingTodoNotice,
  DONE_RECENT_CAP,
  parseTodoSnapshot,
} from "./todo";

describe("todo helpers", () => {
  it("parses actionable, blocked, and done items from their sections", () => {
    const parsed = parseTodoSnapshot(`# TODO

[ACTIONABLE]
- First
- Second

[BLOCKED]
- Waiting on owner

[DONE]
- Read the email`);

    expect(parsed.isValid).toBe(true);
    expect(parsed.actionableItems).toEqual(["First", "Second"]);
    expect(parsed.blockedItems).toEqual(["Waiting on owner"]);
    expect(parsed.doneItems).toEqual(["Read the email"]);
  });

  it("treats missing required sections as invalid", () => {
    const parsed = parseTodoSnapshot(`# TODO

[ACTIONABLE]
- First`);

    expect(parsed.isValid).toBe(false);
    expect(parsed.actionableItems).toEqual(["First"]);
    expect(parsed.blockedItems).toEqual([]);
    expect(parsed.doneItems).toEqual([]);
  });

  it("builds a missing-file reminder with the relative path", () => {
    expect(buildMissingTodoNotice("tasks/abc123/todo.md")).toContain("tasks/abc123/todo.md");
  });
});

describe("buildCappedTodoSnapshot", () => {
  it("returns the original snapshot verbatim when [DONE] is at or below the cap", () => {
    const original = `# TODO

[ACTIONABLE]
- Reply to Alice

[BLOCKED]
- none

[DONE]
- Drafted response
- Read the email`;
    const state = parseTodoSnapshot(original);

    expect(buildCappedTodoSnapshot(state)).toBe(original);
  });

  it("truncates [DONE] to the most recent N entries with an omission marker", () => {
    const doneLines = Array.from({ length: 8 }, (_, i) => `- done-${i + 1}`).join("\n");
    const state = parseTodoSnapshot(`# TODO

[ACTIONABLE]
- next thing

[BLOCKED]
- none

[DONE]
${doneLines}`);

    const capped = buildCappedTodoSnapshot(state);

    // Cap is 5; 8 - 5 = 3 dropped.
    expect(capped).toContain("(... 3 earlier item(s) omitted; full history on disk)");
    expect(capped).toContain("- done-4");
    expect(capped).toContain("- done-5");
    expect(capped).toContain("- done-6");
    expect(capped).toContain("- done-7");
    expect(capped).toContain("- done-8");
    expect(capped).not.toContain("- done-1");
    expect(capped).not.toContain("- done-2");
    expect(capped).not.toContain("- done-3");
  });

  it("preserves [ACTIONABLE] and [BLOCKED] sections after capping", () => {
    const doneLines = Array.from({ length: DONE_RECENT_CAP + 2 }, (_, i) => `- done-${i}`).join("\n");
    const state = parseTodoSnapshot(`# TODO

[ACTIONABLE]
- Send the report
- Confirm with Bob

[BLOCKED]
- Awaiting access

[DONE]
${doneLines}`);

    const capped = buildCappedTodoSnapshot(state);

    expect(capped).toContain("[ACTIONABLE]\n- Send the report\n- Confirm with Bob");
    expect(capped).toContain("[BLOCKED]\n- Awaiting access");
  });

  it("renders empty [ACTIONABLE] and [BLOCKED] sections as `- none`", () => {
    const doneLines = Array.from({ length: DONE_RECENT_CAP + 1 }, (_, i) => `- done-${i}`).join("\n");
    const state = parseTodoSnapshot(`# TODO

[ACTIONABLE]

[BLOCKED]

[DONE]
${doneLines}`);

    const capped = buildCappedTodoSnapshot(state);

    expect(capped).toContain("[ACTIONABLE]\n- none");
    expect(capped).toContain("[BLOCKED]\n- none");
  });
});
