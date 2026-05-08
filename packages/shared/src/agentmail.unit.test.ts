import { describe, expect, it } from "vitest";
import {
  coerceAgentMailAddressList,
  extractAgentMailThreadId,
  extractBareEmailAddress,
} from "./agentmail";

describe("AgentMail helpers", () => {
  it("extracts camelCase and snake_case thread IDs", () => {
    expect(extractAgentMailThreadId({ threadId: " thread-1 " })).toBe("thread-1");
    expect(extractAgentMailThreadId({ thread_id: "thread-2" })).toBe("thread-2");
    expect(extractAgentMailThreadId({ threadId: " " })).toBeNull();
    expect(extractAgentMailThreadId({})).toBeNull();
  });

  it("coerces AgentMail address fields into arrays", () => {
    expect(coerceAgentMailAddressList("person@example.com")).toEqual(["person@example.com"]);
    expect(coerceAgentMailAddressList(["a@example.com", 12])).toEqual(["a@example.com", "12"]);
    expect(coerceAgentMailAddressList(null)).toEqual([]);
  });

  it("extracts and normalizes bare addresses", () => {
    expect(extractBareEmailAddress("Ryan Brewer <Ryan@Example.Com>")).toBe("ryan@example.com");
    expect(extractBareEmailAddress("person@example.com")).toBe("person@example.com");
    expect(extractBareEmailAddress("   ")).toBe("");
    expect(extractBareEmailAddress(null)).toBe("");
  });
});
