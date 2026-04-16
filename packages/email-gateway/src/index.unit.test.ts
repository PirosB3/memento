import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirstMock } = vi.hoisted(() => ({ findFirstMock: vi.fn() }));

vi.mock("@summon/shared", () => ({
  prisma: {
    emailContact: {
      findFirst: findFirstMock,
    },
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getTemporalAddress: () => "localhost:7233",
  SIGNAL_EMAIL: "on_email",
  SIGNAL_OWNER: "on_owner_response",
}));

import {
  collectOutboundRecipients,
  extractBareAddress,
  isKnownContact,
  isSelfSentEmail,
  parseTag,
} from "./index";

beforeEach(() => {
  findFirstMock.mockReset();
});

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

describe("extractBareAddress", () => {
  it("returns the address unchanged for a bare input", () => {
    expect(extractBareAddress("ryan@example.com")).toBe("ryan@example.com");
  });

  it("strips display-name wrapping", () => {
    expect(extractBareAddress("Ryan Brewer <ryan@example.com>")).toBe("ryan@example.com");
    expect(extractBareAddress('"Ryan Brewer" <ryan@example.com>')).toBe("ryan@example.com");
  });

  it("lowercases the result", () => {
    expect(extractBareAddress("Ryan@EXAMPLE.com")).toBe("ryan@example.com");
    expect(extractBareAddress("Ryan <Ryan@Example.Com>")).toBe("ryan@example.com");
  });

  it("returns empty string for null/undefined/whitespace", () => {
    expect(extractBareAddress(null)).toBe("");
    expect(extractBareAddress(undefined)).toBe("");
    expect(extractBareAddress("")).toBe("");
    expect(extractBareAddress("   ")).toBe("");
  });
});

describe("collectOutboundRecipients", () => {
  const agentEmail = "avery@agentmail.test";

  it("extracts to+cc recipients from a sent-labeled message", () => {
    const out = new Set<string>();
    collectOutboundRecipients(
      {
        labels: ["sent"],
        from: "Avery <avery@agentmail.test>",
        to: ["Ryan <ryan@example.com>"],
        cc: ["hiring@example.org", "Daniel <daniel@example.net>"],
      },
      agentEmail,
      out,
    );

    expect([...out].sort()).toEqual([
      "daniel@example.net",
      "hiring@example.org",
      "ryan@example.com",
    ]);
  });

  it("also accepts messages where from is self (regardless of labels)", () => {
    const out = new Set<string>();
    collectOutboundRecipients(
      {
        labels: ["received"],
        from: "avery@agentmail.test",
        to: ["ryan@example.com"],
      },
      agentEmail,
      out,
    );

    expect([...out]).toEqual(["ryan@example.com"]);
  });

  it("skips received-only messages from third parties", () => {
    const out = new Set<string>();
    collectOutboundRecipients(
      {
        labels: ["received"],
        from: "Ryan <ryan@example.com>",
        to: ["Avery <avery@agentmail.test>"],
        cc: ["daniel@example.com"],
      },
      agentEmail,
      out,
    );

    expect(out.size).toBe(0);
  });

  it("skips self and +tag routing addresses", () => {
    const out = new Set<string>();
    collectOutboundRecipients(
      {
        labels: ["sent"],
        from: "avery@agentmail.test",
        to: [
          "ryan@example.com",
          "Avery <avery@agentmail.test>",
          "avery+abc123@agentmail.test",
        ],
        cc: ["avery+root@agentmail.test"],
      },
      agentEmail,
      out,
    );

    expect([...out]).toEqual(["ryan@example.com"]);
  });

  it("dedupes an address that appears in both to and cc", () => {
    const out = new Set<string>();
    collectOutboundRecipients(
      {
        labels: ["sent"],
        from: "avery@agentmail.test",
        to: ["Ryan <ryan@example.com>"],
        cc: ["ryan@example.com"],
      },
      agentEmail,
      out,
    );

    expect([...out]).toEqual(["ryan@example.com"]);
  });

  it("handles missing to/cc fields without throwing", () => {
    const out = new Set<string>();
    collectOutboundRecipients(
      {
        labels: ["sent"],
        from: "avery@agentmail.test",
      },
      agentEmail,
      out,
    );

    expect(out.size).toBe(0);
  });
});

describe("isKnownContact", () => {
  it("returns true when a matching row exists", async () => {
    findFirstMock.mockResolvedValueOnce({ id: 42 });

    const result = await isKnownContact("avery@agentmail.test", "Ryan@Example.COM");

    expect(result).toBe(true);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { inboxId: "avery@agentmail.test", emailAddress: "ryan@example.com" },
      select: { id: true },
    });
  });

  it("returns false when no matching row exists", async () => {
    findFirstMock.mockResolvedValueOnce(null);

    const result = await isKnownContact("avery@agentmail.test", "stranger@example.com");

    expect(result).toBe(false);
    expect(findFirstMock).toHaveBeenCalledOnce();
  });

  it("returns false without touching prisma when the address is empty", async () => {
    const resultEmpty = await isKnownContact("avery@agentmail.test", "");
    const resultWhitespace = await isKnownContact("avery@agentmail.test", "   ");

    expect(resultEmpty).toBe(false);
    expect(resultWhitespace).toBe(false);
    expect(findFirstMock).not.toHaveBeenCalled();
  });
});
