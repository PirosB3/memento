import { describe, expect, it } from "vitest";
import { isSelfSentEmail, parseTag } from "./index";

describe("email gateway helpers", () => {
  it("parses a task tag from tagged recipient addresses", () => {
    const tag = parseTag(
      [
        "Avery <avery+abc123@agentmail.test>",
        "other@example.com",
      ],
      "avery@agentmail.test",
    );

    expect(tag).toBe("abc123");
  });

  it("returns null when no tagged recipient is present", () => {
    expect(parseTag(["owner@example.com"], "avery@agentmail.test")).toBeNull();
  });

  it("detects self-sent messages by local part", () => {
    expect(isSelfSentEmail("Avery <avery@agentmail.test>", "avery@agentmail.test")).toBe(true);
    expect(isSelfSentEmail("Owner <owner@example.com>", "avery@agentmail.test")).toBe(false);
  });
});
