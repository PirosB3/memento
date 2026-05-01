import { describe, expect, it } from "vitest";
import { getTaskMessageAction } from "./task-status";

describe("getTaskMessageAction", () => {
  it.each([
    ["SLEEPING", "RUNNING"],
    ["ESCALATED", "RUNNING"],
    ["COMPLETED", "RUNNING"],
  ] as const)("wakes %s tasks with %s workflows", (status, workflowStatus) => {
    expect(getTaskMessageAction({ status, workflowStatus, isRoot: false })).toBe("wake");
  });

  it.each([
    ["SLEEPING", "STOPPED"],
    ["ESCALATED", "STOPPED"],
    ["COMPLETED", "STOPPED"],
  ] as const)("restarts stopped child tasks with owner messages for %s", (status, workflowStatus) => {
    expect(getTaskMessageAction({ status, workflowStatus, isRoot: false })).toBe("restart-with-message");
  });

  it("does not restart stopped root workflows with an owner message", () => {
    expect(getTaskMessageAction({ status: "SLEEPING", workflowStatus: "STOPPED", isRoot: true })).toBe("disabled");
  });

  it("does not inject owner messages into actively running tasks", () => {
    expect(getTaskMessageAction({ status: "RUNNING", workflowStatus: "RUNNING", isRoot: false })).toBe("disabled");
  });
});
