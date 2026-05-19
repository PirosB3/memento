import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  emailContactFindFirstMock,
  taskFindFirstMock,
  findTaskByAgentmailThreadIdMock,
  recordTaskThreadIdMock,
  MockAgentMailThreadBindingConflictError,
} = vi.hoisted(() => {
  class MockBindingConflictError extends Error {
    agentmailThreadId: string;
    requestedTaskId: string;
    existingTaskId: string;

    constructor(args: {
      agentmailThreadId: string;
      requestedTaskId: string;
      existingTaskId: string;
    }) {
      super("binding conflict");
      this.agentmailThreadId = args.agentmailThreadId;
      this.requestedTaskId = args.requestedTaskId;
      this.existingTaskId = args.existingTaskId;
    }
  }

  return {
    emailContactFindFirstMock: vi.fn(),
    taskFindFirstMock: vi.fn(),
    findTaskByAgentmailThreadIdMock: vi.fn(),
    recordTaskThreadIdMock: vi.fn(),
    MockAgentMailThreadBindingConflictError: MockBindingConflictError,
  };
});

vi.mock("@summon/shared", () => ({
  prisma: {
    emailContact: {
      findFirst: emailContactFindFirstMock,
    },
    task: {
      findFirst: taskFindFirstMock,
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
  findTaskByAgentmailThreadId: findTaskByAgentmailThreadIdMock,
  recordTaskThreadId: recordTaskThreadIdMock,
  AgentMailThreadBindingConflictError: MockAgentMailThreadBindingConflictError,
  coerceAgentMailAddressList: (raw: unknown) => {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === "string") return [raw];
    return [];
  },
  extractAgentMailThreadId: (msg: Record<string, unknown>) => {
    const threadId = msg.threadId ?? msg.thread_id;
    return typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
  },
  extractBareEmailAddress: (raw: string | undefined | null) => {
    if (!raw) return "";
    const trimmed = raw.trim();
    if (!trimmed) return "";
    const match = trimmed.match(/<([^>]+)>/);
    return (match?.[1] ?? trimmed).trim().toLowerCase();
  },
  isAgentSelfEmail: (fromField: string, agentEmail: string) => {
    const from = (() => {
      const trimmed = fromField.trim();
      const match = trimmed.match(/<([^>]+)>/);
      return (match?.[1] ?? trimmed).trim().toLowerCase();
    })();
    if (!from) return false;
    const [local, domain] = agentEmail.toLowerCase().split("@");
    if (!local || !domain) return false;
    const base = `${local}@${domain}`;
    if (from === base) return true;
    return from.startsWith(`${local}+`) && from.endsWith(`@${domain}`);
  },
}));

import {
  collectOutboundRecipients,
  extractLegacyTagFromRecipients,
  extractBareAddress,
  isKnownContact,
  isSelfSentEmail,
  resolveTargetWorkflow,
} from "./index";

beforeEach(() => {
  emailContactFindFirstMock.mockReset();
  taskFindFirstMock.mockReset();
  findTaskByAgentmailThreadIdMock.mockReset();
  recordTaskThreadIdMock.mockReset();
});

describe("email gateway helpers", () => {
  it("detects self-sent messages by parsed address", () => {
    expect(isSelfSentEmail("Avery <avery@agentmail.test>", "avery@agentmail.test")).toBe(true);
    expect(isSelfSentEmail("avery+abc@agentmail.test", "avery@agentmail.test")).toBe(true);
    expect(isSelfSentEmail("Owner <owner@example.com>", "avery@agentmail.test")).toBe(false);
  });

  it("does not treat similar local-part substrings as self-sent", () => {
    expect(isSelfSentEmail("Not Mario <notmario@evil.example>", "mario@agentmail.test")).toBe(false);
  });
});

describe("resolveTargetWorkflow", () => {
  function makeTemporal(running: Record<string, boolean>) {
    return {
      workflow: {
        getHandle: (workflowId: string) => ({
          describe: async () => ({
            status: { name: running[workflowId] ? "RUNNING" : "COMPLETED" },
          }),
        }),
      },
    } as unknown as Parameters<typeof resolveTargetWorkflow>[0];
  }

  const agent = { agentId: "agent-1", agentEmail: "avery@agentmail.test" };

  it("routes to a child task when the AgentMail threadId matches a bridge binding", async () => {
    findTaskByAgentmailThreadIdMock.mockResolvedValueOnce({ taskId: "task-x" });
    const temporal = makeTemporal({ "task-task-x": true });

    const result = await resolveTargetWorkflow(temporal, agent, {
      messageId: "m1",
      timestamp: "2026-05-07T00:00:00Z",
      senderEmail: "ryan@example.com",
      isOwner: false,
      agentmailThreadId: "thread-AAA",
      legacyTag: null,
    });

    expect(result).toEqual({ workflowId: "task-task-x" });
    expect(findTaskByAgentmailThreadIdMock).toHaveBeenCalledWith(expect.anything(), {
      agentId: "agent-1",
      agentmailThreadId: "thread-AAA",
    });
  });

  it("routes to root when the threadId is not bound to any task", async () => {
    findTaskByAgentmailThreadIdMock.mockResolvedValueOnce(null);
    const temporal = makeTemporal({ "agent__agent-1__root": true });

    const result = await resolveTargetWorkflow(temporal, agent, {
      messageId: "m2",
      timestamp: "2026-05-07T00:00:00Z",
      senderEmail: "ryan@example.com",
      isOwner: false,
      agentmailThreadId: "thread-unmatched",
      legacyTag: null,
    });

    expect(result).toEqual({ workflowId: "agent__agent-1__root" });
  });

  it("routes to root when the message has no threadId at all", async () => {
    const temporal = makeTemporal({ "agent__agent-1__root": true });

    const result = await resolveTargetWorkflow(temporal, agent, {
      messageId: "m3",
      timestamp: "2026-05-07T00:00:00Z",
      senderEmail: "ryan@example.com",
      isOwner: false,
      agentmailThreadId: null,
      legacyTag: null,
    });

    expect(result).toEqual({ workflowId: "agent__agent-1__root" });
    expect(findTaskByAgentmailThreadIdMock).not.toHaveBeenCalled();
  });

  it("defers when the matched child workflow is stopped", async () => {
    findTaskByAgentmailThreadIdMock.mockResolvedValueOnce({ taskId: "task-y" });
    const temporal = makeTemporal({ "task-task-y": false });

    const result = await resolveTargetWorkflow(temporal, agent, {
      messageId: "m4",
      timestamp: "2026-05-07T00:00:00Z",
      senderEmail: "ryan@example.com",
      isOwner: false,
      agentmailThreadId: "thread-Y",
      legacyTag: null,
    });

    expect(result).toBeNull();
  });

  it("defers when no task matches and the root workflow is stopped", async () => {
    findTaskByAgentmailThreadIdMock.mockResolvedValueOnce(null);
    const temporal = makeTemporal({ "agent__agent-1__root": false });

    const result = await resolveTargetWorkflow(temporal, agent, {
      messageId: "m5",
      timestamp: "2026-05-07T00:00:00Z",
      senderEmail: "ryan@example.com",
      isOwner: false,
      agentmailThreadId: "thread-Z",
      legacyTag: null,
    });

    expect(result).toBeNull();
  });

  it("uses the legacy +tag fallback during cutover and records the bridge binding", async () => {
    findTaskByAgentmailThreadIdMock.mockResolvedValueOnce(null);
    taskFindFirstMock.mockResolvedValueOnce({ taskId: "task-legacy" });
    recordTaskThreadIdMock.mockResolvedValueOnce(undefined);
    const temporal = makeTemporal({ "task-task-legacy": true });

    const result = await resolveTargetWorkflow(temporal, agent, {
      messageId: "m6",
      timestamp: "2026-05-07T00:00:00Z",
      senderEmail: "ryan@example.com",
      isOwner: false,
      agentmailThreadId: "thread-legacy",
      legacyTag: "legacy-tag",
    });

    expect(result).toEqual({ workflowId: "task-task-legacy" });
    expect(taskFindFirstMock).toHaveBeenCalledWith({
      where: { agentId: "agent-1", tag: "legacy-tag", isRoot: false },
      select: { taskId: true },
    });
    expect(recordTaskThreadIdMock).toHaveBeenCalledWith(expect.anything(), {
      taskId: "task-legacy",
      agentmailThreadId: "thread-legacy",
    });
  });

  it("does not route a legacy +tag fallback when bridge binding creation conflicts", async () => {
    findTaskByAgentmailThreadIdMock.mockResolvedValueOnce(null);
    taskFindFirstMock.mockResolvedValueOnce({ taskId: "task-legacy" });
    recordTaskThreadIdMock.mockRejectedValueOnce(new MockAgentMailThreadBindingConflictError({
      agentmailThreadId: "thread-legacy",
      requestedTaskId: "task-legacy",
      existingTaskId: "task-other",
    }));
    const temporal = makeTemporal({ "task-task-legacy": true });

    const result = await resolveTargetWorkflow(temporal, agent, {
      messageId: "m7",
      timestamp: "2026-05-07T00:00:00Z",
      senderEmail: "ryan@example.com",
      isOwner: false,
      agentmailThreadId: "thread-legacy",
      legacyTag: "legacy-tag",
    });

    expect(result).toBeNull();
  });
});

describe("extractLegacyTagFromRecipients", () => {
  it("extracts a legacy +tag from to/cc recipients for the same inbox", () => {
    expect(extractLegacyTagFromRecipients({
      to: ["Avery <avery@agentmail.test>"],
      cc: ["avery+task-123@agentmail.test"],
    }, "avery@agentmail.test")).toBe("task-123");
  });

  it("ignores plus-addresses for other domains or local parts", () => {
    expect(extractLegacyTagFromRecipients({
      to: ["avery+task-123@example.com", "other+task-123@agentmail.test"],
      cc: [],
    }, "avery@agentmail.test")).toBeNull();
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
    emailContactFindFirstMock.mockResolvedValueOnce({ id: 42 });

    const result = await isKnownContact("avery@agentmail.test", "Ryan@Example.COM");

    expect(result).toBe(true);
    expect(emailContactFindFirstMock).toHaveBeenCalledWith({
      where: { inboxId: "avery@agentmail.test", emailAddress: "ryan@example.com" },
      select: { id: true },
    });
  });

  it("returns false when no matching row exists", async () => {
    emailContactFindFirstMock.mockResolvedValueOnce(null);

    const result = await isKnownContact("avery@agentmail.test", "stranger@example.com");

    expect(result).toBe(false);
    expect(emailContactFindFirstMock).toHaveBeenCalledOnce();
  });

  it("returns false without touching prisma when the address is empty", async () => {
    const resultEmpty = await isKnownContact("avery@agentmail.test", "");
    const resultWhitespace = await isKnownContact("avery@agentmail.test", "   ");

    expect(resultEmpty).toBe(false);
    expect(resultWhitespace).toBe(false);
    expect(emailContactFindFirstMock).not.toHaveBeenCalled();
  });
});
