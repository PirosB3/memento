import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt";

describe("buildSystemPrompt", () => {
  it("returns a static root prompt", () => {
    const promptA = buildSystemPrompt(true);
    const promptB = buildSystemPrompt(true);

    expect(promptA).toEqual(promptB);
    expect(promptA).toContain("You are a DELEGATOR, not a doer.");
    expect(promptA).toContain("The context seed message contains the stable agent/task snapshot.");
    expect(promptA).not.toContain("Avery");
    expect(promptA).not.toContain("owner@example.com");
  });

  it("returns a static child prompt", () => {
    const promptA = buildSystemPrompt(false);
    const promptB = buildSystemPrompt(false);

    expect(promptA).toEqual(promptB);
    expect(promptA).toContain("You are a focused AI email agent operating as a child task.");
    expect(promptA).toContain("tasks/<task-tag>/todo.md");
    expect(promptA).toContain("Use `sleep` only when `[ACTIONABLE]` is empty.");
    expect(promptA).toContain("ESCALATE OVER SILENCE");
    expect(promptA).toContain("Never quit work silently.");
    expect(promptA).not.toContain("avery+abc123@agentmail.test");
  });

  it("child prompt teaches sleep-rejection recovery instead of fail", () => {
    const prompt = buildSystemPrompt(false);
    expect(prompt).toContain("If `decide(sleep)` is rejected");
    expect(prompt).toContain("Never call `decide(fail)` to escape a sleep rejection");
    expect(prompt).toContain("auto-defers after 3 rejected sleep attempts");
  });

  it("child prompt teaches multi-turn decomposition", () => {
    const prompt = buildSystemPrompt(false);
    expect(prompt).toContain("Multi-turn work is the norm");
    expect(prompt).toContain("decompose it into 3\u20135 concrete `[ACTIONABLE]` items");
  });

  it("child prompt contains DECIDE CONTRACT with fail marked terminal", () => {
    const prompt = buildSystemPrompt(false);
    expect(prompt).toContain("## DECIDE CONTRACT");
    expect(prompt).toContain("`fail`: **TERMINAL**");
    expect(prompt).toContain("The platform emails the owner automatically");
    expect(prompt).toContain("Do NOT use `fail` for \"I ran out of turn time\"");
  });

  it("child prompt contains RECOVERY LADDER with fail as last resort", () => {
    const prompt = buildSystemPrompt(false);
    expect(prompt).toContain("## RECOVERY LADDER");
    expect(prompt).toContain("LAST RESORT: `decide(fail)`");
  });

  it("both prompts include TOOL SURFACE REALITY verification guidance", () => {
    const rootPrompt = buildSystemPrompt(true);
    const childPrompt = buildSystemPrompt(false);
    for (const prompt of [rootPrompt, childPrompt]) {
      expect(prompt).toContain("## TOOL SURFACE REALITY");
      expect(prompt).toContain("run `<cmd> --help`");
      expect(prompt).toContain("only the Pi agent tools");
    }
  });

  it("root prompt contains DECIDE CONTRACT without complete/fail", () => {
    const prompt = buildSystemPrompt(true);
    expect(prompt).toContain("## DECIDE CONTRACT");
    expect(prompt).toContain("cannot `complete` or `fail`");
  });

  it("root prompt explains child failure handling", () => {
    const prompt = buildSystemPrompt(true);
    expect(prompt).toContain("## CHILD TASK FAILURE HANDLING");
    expect(prompt).toContain("the platform automatically emails the owner");
    expect(prompt).toContain("wake_task");
  });
});
