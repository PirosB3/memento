import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFilteredReadEmailsTool,
  createReplyEmailTool,
  createSendEmailTool,
  setAgentMailClientForTests,
} from "./agentmail-tools";

let tempDirs: string[] = [];

afterEach(() => {
  setAgentMailClientForTests(null);
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function createTempAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmail-tools-"));
  tempDirs.push(dir);
  return dir;
}

describe("agentmail tools", () => {
  it("auto-ccs the tagged address for child task sends and dedupes it", async () => {
    const agentDir = createTempAgentDir();
    const send = vi.fn().mockResolvedValue({ messageId: "msg-1" });
    setAgentMailClientForTests({
      inboxes: {
        messages: {
          send,
          reply: vi.fn(),
          get: vi.fn(),
          list: vi.fn(),
        },
        threads: {
          list: vi.fn(),
        },
      },
    });

    const tool = createSendEmailTool("avery@agentmail.test", agentDir, "abc123");
    await tool.execute("call-1", {
      to: "person@example.com",
      subject: "Hello",
      body: "Hi there",
      cc: ["owner@example.com", "avery+abc123@agentmail.test"],
    });

    expect(send).toHaveBeenCalledWith(
      "avery@agentmail.test",
      expect.objectContaining({
        cc: ["owner@example.com", "avery+abc123@agentmail.test"],
      }),
    );
  });

  it("supports multiple recipients, html, bcc, and attachments on send", async () => {
    const agentDir = createTempAgentDir();
    fs.mkdirSync(path.join(agentDir, "generated"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "generated", "hello.txt"), "hello from test", "utf-8");

    const send = vi.fn().mockResolvedValue({ messageId: "msg-2" });
    setAgentMailClientForTests({
      inboxes: {
        messages: {
          send,
          reply: vi.fn(),
          get: vi.fn(),
          list: vi.fn(),
        },
        threads: {
          list: vi.fn(),
        },
      },
    });

    const tool = createSendEmailTool("avery@agentmail.test", agentDir);
    const result = await tool.execute("call-2", {
      to: ["person@example.com", "other@example.com", "person@example.com"],
      subject: "Hello",
      body: "Plain text",
      html: "<p>Hello</p>",
      cc: ["owner@example.com"],
      bcc: ["audit@example.com"],
      attachments: [{ path: "generated/hello.txt", contentType: "text/plain" }],
    });

    expect(send).toHaveBeenCalledWith(
      "avery@agentmail.test",
      expect.objectContaining({
        to: ["person@example.com", "other@example.com"],
        subject: "Hello",
        text: "Plain text",
        html: "<p>Hello</p>",
        cc: ["owner@example.com"],
        bcc: ["audit@example.com"],
        attachments: [
          expect.objectContaining({
            filename: "hello.txt",
            contentType: "text/plain",
            content: Buffer.from("hello from test", "utf-8").toString("base64"),
          }),
        ],
      }),
    );
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("to person@example.com, other@example.com");
      expect(result.content[0].text).toContain("1 attachment (generated/hello.txt)");
    }
  });

  it("rejects sends with no content", async () => {
    const agentDir = createTempAgentDir();
    const send = vi.fn();
    setAgentMailClientForTests({
      inboxes: {
        messages: {
          send,
          reply: vi.fn(),
          get: vi.fn(),
          list: vi.fn(),
        },
        threads: {
          list: vi.fn(),
        },
      },
    });

    const tool = createSendEmailTool("avery@agentmail.test", agentDir);
    const result = await tool.execute("call-3", {
      to: "person@example.com",
      subject: "Hello",
    });

    expect(send).not.toHaveBeenCalled();
    expect(result.details).toEqual({ error: true });
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("Provide at least one of body, html, or attachments.");
    }
  });

  it("rejects missing attachment files and path traversal", async () => {
    const agentDir = createTempAgentDir();
    const send = vi.fn();
    setAgentMailClientForTests({
      inboxes: {
        messages: {
          send,
          reply: vi.fn(),
          get: vi.fn(),
          list: vi.fn(),
        },
        threads: {
          list: vi.fn(),
        },
      },
    });

    const tool = createSendEmailTool("avery@agentmail.test", agentDir);
    const missingResult = await tool.execute("call-4", {
      to: "person@example.com",
      subject: "Hello",
      attachments: [{ path: "generated/missing.txt" }],
    });
    const traversalResult = await tool.execute("call-5", {
      to: "person@example.com",
      subject: "Hello",
      attachments: [{ path: "../secret.txt" }],
    });

    expect(send).not.toHaveBeenCalled();
    expect(missingResult.details).toEqual({ error: true });
    expect(traversalResult.details).toEqual({ error: true });
    expect(missingResult.content[0]?.type).toBe("text");
    expect(traversalResult.content[0]?.type).toBe("text");
    if (missingResult.content[0]?.type === "text") {
      expect(missingResult.content[0].text).toContain("Attachment file not found or unreadable");
    }
    if (traversalResult.content[0]?.type === "text") {
      expect(traversalResult.content[0].text).toContain("Attachment path traversal not allowed");
    }
  });

  it("supports reply-all and attachments on replies", async () => {
    const agentDir = createTempAgentDir();
    fs.writeFileSync(path.join(agentDir, "notes.txt"), "reply attachment", "utf-8");

    const reply = vi.fn().mockResolvedValue({ messageId: "msg-reply" });
    setAgentMailClientForTests({
      inboxes: {
        messages: {
          send: vi.fn(),
          reply,
          get: vi.fn(),
          list: vi.fn(),
        },
        threads: {
          list: vi.fn(),
        },
      },
    });

    const tool = createReplyEmailTool("avery@agentmail.test", agentDir, "abc123");
    const result = await tool.execute("call-6", {
      messageId: "orig-msg",
      body: "Reply body",
      replyAll: true,
      cc: ["owner@example.com"],
      bcc: ["audit@example.com"],
      attachments: [{ path: "notes.txt", filename: "reply.txt", contentType: "text/plain" }],
    });

    expect(reply).toHaveBeenCalledWith(
      "avery@agentmail.test",
      "orig-msg",
      expect.objectContaining({
        text: "Reply body",
        replyAll: true,
        cc: ["owner@example.com", "avery+abc123@agentmail.test"],
        bcc: ["audit@example.com"],
        attachments: [
          expect.objectContaining({
            filename: "reply.txt",
            contentType: "text/plain",
            content: Buffer.from("reply attachment", "utf-8").toString("base64"),
          }),
        ],
      }),
    );
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("reply-all");
      expect(result.content[0].text).toContain("1 attachment (reply.txt)");
    }
  });

  it("filters child task emails to tagged threads only", async () => {
    createTempAgentDir();
    const threadsList = vi.fn().mockResolvedValue({
      threads: [
        {
          threadId: "thread-1",
          recipients: ["avery+abc123@agentmail.test"],
          senders: ["owner@example.com"],
        },
        {
          threadId: "thread-2",
          recipients: ["avery@agentmail.test"],
          senders: ["other@example.com"],
        },
      ],
    });
    const messagesList = vi.fn().mockResolvedValue({
      messages: [
        {
          threadId: "thread-1",
          from: "owner@example.com",
          to: ["avery+abc123@agentmail.test"],
          cc: [],
          subject: "Tagged",
          labels: ["received"],
          messageId: "msg-1",
        },
        {
          threadId: "thread-2",
          from: "other@example.com",
          to: ["avery@agentmail.test"],
          cc: [],
          subject: "Untagged",
          labels: ["received"],
          messageId: "msg-2",
        },
      ],
    });

    setAgentMailClientForTests({
      inboxes: {
        messages: {
          send: vi.fn(),
          reply: vi.fn(),
          get: vi.fn(),
          list: messagesList,
        },
        threads: {
          list: threadsList,
        },
      },
    });

    const tool = createFilteredReadEmailsTool("avery@agentmail.test", "abc123");
    const result = await tool.execute("call-1", { limit: 10 });
    const textResult = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(textResult).toContain("Tagged");
    expect(textResult).not.toContain("Untagged");
  });
});
