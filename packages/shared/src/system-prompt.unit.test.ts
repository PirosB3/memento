import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt";

describe("buildSystemPrompt", () => {
  it("returns a static root prompt", () => {
    const promptA = buildSystemPrompt(true);
    const promptB = buildSystemPrompt(true);

    expect(promptA).toEqual(promptB);
    expect(promptA).toContain("You are a DELEGATOR, not a doer.");
    expect(promptA).toContain("The context seed message contains the stable agent/task snapshot.");
    expect(promptA).toContain("## REPLY CHANNEL");
    expect(promptA).toContain("Match the wake channel");
    expect(promptA).toContain("## INBOUND EMAIL TRIAGE");
    expect(promptA).toContain("route_email_to_thread");
    expect(promptA).not.toContain("## INBOX SCOPE");
    expect(promptA).not.toContain("Avery");
    expect(promptA).not.toContain("owner@example.com");
    expect(promptA).not.toContain("## AVAILABLE SKILLS");
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
    expect(promptA).toContain("## REPLY CHANNEL");
    expect(promptA).toContain("Match the wake channel");
    expect(promptA).toContain("## INBOX SCOPE");
    expect(promptA).toContain("entire inbox, including");
    expect(promptA).not.toContain("## INBOUND EMAIL TRIAGE");
    expect(promptA).not.toContain("route_email_to_thread");
    expect(promptA).not.toContain("avery+abc123@agentmail.test");
    expect(promptA).not.toContain("## AVAILABLE SKILLS");
  });

  it("injects an available skills manifest after skill management guidance", () => {
    const prompt = buildSystemPrompt(
      false,
      "## AVAILABLE SKILLS\n- gws: Use Google Workspace. (path: shared/skills/gws/SKILL.md)",
    );

    expect(prompt).toContain("Never install into shared/ and never use global install flags.\n\n## AVAILABLE SKILLS");
    expect(prompt).toContain("- gws: Use Google Workspace. (path: shared/skills/gws/SKILL.md)");
    expect(prompt).toContain("## PYTHON WORK");
  });
});
