import { describe, expect, it } from "vitest";
import {
  buildMissingTodoNotice,
  parseTodoSnapshot,
} from "./todo";

describe("todo helpers", () => {
  it("parses actionable items from the actionable section only", () => {
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
  });

  it("treats missing required sections as invalid", () => {
    const parsed = parseTodoSnapshot(`# TODO

[ACTIONABLE]
- First`);

    expect(parsed.isValid).toBe(false);
    expect(parsed.actionableItems).toEqual(["First"]);
  });

  it("builds a missing-file reminder with the relative path", () => {
    expect(buildMissingTodoNotice("tasks/abc123/todo.md")).toContain("tasks/abc123/todo.md");
  });
});
