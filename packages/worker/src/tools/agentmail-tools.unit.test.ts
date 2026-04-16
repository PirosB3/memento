import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDownloadEmailAttachmentTool,
  createFilteredReadEmailsTool,
  createReadEmailTool,
  createReplyEmailTool,
  createSendEmailTool,
  sendOwnerNotification,
  setAgentMailClientForTests,
} from "./agentmail-tools";

let tempDirs: string[] = [];

afterEach(() => {
  setAgentMailClientForTests(null);
  vi.unstubAllGlobals();
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

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text ?? "" : "";
}

function createAgentMailStub() {
  const client = {
    inboxes: {
      messages: {
        send: vi.fn(),
        reply: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        getAttachment: vi.fn(),
      },
      threads: {
        list: vi.fn(),
      },
    },
  };

  setAgentMailClientForTests(client);
  return client;
}

function createArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("agentmail tools", () => {
  it("auto-ccs the tagged address for child task sends and dedupes it", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.send.mockResolvedValue({ messageId: "msg-1" });

    const tool = createSendEmailTool("avery@agentmail.test", agentDir, "abc123");
    await tool.execute("call-1", {
      to: "person@example.com",
      subject: "Hello",
      body: "Hi there",
      cc: ["owner@example.com", "avery+abc123@agentmail.test"],
    });

    expect(client.inboxes.messages.send).toHaveBeenCalledWith(
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

    const client = createAgentMailStub();
    client.inboxes.messages.send.mockResolvedValue({ messageId: "msg-2" });

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

    expect(client.inboxes.messages.send).toHaveBeenCalledWith(
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

    expect(getText(result)).toContain("to person@example.com, other@example.com");
    expect(getText(result)).toContain("1 attachment (generated/hello.txt)");
  });

  it("rejects sends with no content", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();

    const tool = createSendEmailTool("avery@agentmail.test", agentDir);
    const result = await tool.execute("call-3", {
      to: "person@example.com",
      subject: "Hello",
    });

    expect(client.inboxes.messages.send).not.toHaveBeenCalled();
    expect(result.details).toEqual({ error: true });
    expect(getText(result)).toContain("Provide at least one of body, html, or attachments.");
  });

  it("rejects missing attachment files and path traversal", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();

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

    expect(client.inboxes.messages.send).not.toHaveBeenCalled();
    expect(missingResult.details).toEqual({ error: true });
    expect(traversalResult.details).toEqual({ error: true });
    expect(getText(missingResult)).toContain("Attachment file not found or unreadable");
    expect(getText(traversalResult)).toContain("Attachment path traversal not allowed");
  });

  it("manually constructs reply-all recipients for a child task (no replyAll flag, +tag in cc)", async () => {
    const agentDir = createTempAgentDir();
    fs.writeFileSync(path.join(agentDir, "notes.txt"), "reply attachment", "utf-8");

    const client = createAgentMailStub();
    client.inboxes.messages.get.mockResolvedValue({
      messageId: "orig-msg",
      from: "ryan@example.net",
      to: ["daniel@example.com", "avery@agentmail.test"],
      cc: ["observer@example.com"],
    });
    client.inboxes.messages.reply.mockResolvedValue({ messageId: "msg-reply" });

    const tool = createReplyEmailTool("avery@agentmail.test", agentDir, "abc123");
    const result = await tool.execute("call-6", {
      messageId: "orig-msg",
      body: "Reply body",
      replyAll: true,
      cc: ["owner@example.com"],
      bcc: ["audit@example.com"],
      attachments: [{ path: "notes.txt", filename: "reply.txt", contentType: "text/plain" }],
    });

    expect(client.inboxes.messages.get).toHaveBeenCalledWith("avery@agentmail.test", "orig-msg");

    const [, , payload] = client.inboxes.messages.reply.mock.calls[0];
    expect(payload).toEqual(
      expect.objectContaining({
        text: "Reply body",
        to: ["ryan@example.net"],
        cc: ["daniel@example.com", "observer@example.com", "owner@example.com", "avery+abc123@agentmail.test"],
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
    expect(payload).not.toHaveProperty("replyAll");

    expect(getText(result)).toContain("reply-all");
    expect(getText(result)).toContain("1 attachment (reply.txt)");
  });

  it("uses the native replyAll flag for root task replies (no tag, no manual construction)", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.reply.mockResolvedValue({ messageId: "msg-reply-root" });

    const tool = createReplyEmailTool("avery@agentmail.test", agentDir);
    await tool.execute("call-root-reply", {
      messageId: "orig-msg",
      body: "Root reply",
      replyAll: true,
    });

    expect(client.inboxes.messages.get).not.toHaveBeenCalled();
    expect(client.inboxes.messages.reply).toHaveBeenCalledWith(
      "avery@agentmail.test",
      "orig-msg",
      expect.objectContaining({
        text: "Root reply",
        replyAll: true,
      }),
    );
  });

  it("falls back to original recipients when replying to own sent message (child task)", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.get.mockResolvedValue({
      messageId: "orig-msg",
      from: "avery+abc123@agentmail.test",
      to: ["ryan@example.net", "daniel@example.com"],
      cc: [],
    });
    client.inboxes.messages.reply.mockResolvedValue({ messageId: "msg-reply-fallback" });

    const tool = createReplyEmailTool("avery@agentmail.test", agentDir, "abc123");
    await tool.execute("call-self-from", {
      messageId: "orig-msg",
      body: "Bump",
      replyAll: true,
    });

    const [, , payload] = client.inboxes.messages.reply.mock.calls[0];
    expect(payload.to).toEqual(["ryan@example.net"]);
    expect(payload.cc).toEqual(["daniel@example.com", "avery+abc123@agentmail.test"]);
    expect(payload).not.toHaveProperty("replyAll");
  });

  it("filters self addresses wrapped in display-name format during child task reply-all", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.get.mockResolvedValue({
      messageId: "orig-msg",
      from: "Avery Agent <avery+abc123@agentmail.test>",
      to: [
        "Ryan <ryan@example.net>",
        "\"Avery\" <avery@agentmail.test>",
      ],
      cc: ["Daniel <daniel@example.com>"],
    });
    client.inboxes.messages.reply.mockResolvedValue({ messageId: "msg-reply-display" });

    const tool = createReplyEmailTool("avery@agentmail.test", agentDir, "abc123");
    await tool.execute("call-display-self", {
      messageId: "orig-msg",
      body: "Bump",
      replyAll: true,
    });

    const [, , payload] = client.inboxes.messages.reply.mock.calls[0];
    // Self "from" (display-name wrapped) must fall back to original recipients.
    expect(payload.to).toEqual(["Ryan <ryan@example.net>"]);
    // Self "to" entry (display-name wrapped) must be dropped; "daniel" stays; +tag appended.
    expect(payload.cc).toEqual(["Daniel <daniel@example.com>", "avery+abc123@agentmail.test"]);
    expect(payload).not.toHaveProperty("replyAll");
  });

  it("dedupes cc entries that repeat the to recipient in display-name format", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.get.mockResolvedValue({
      messageId: "orig-msg",
      from: "Ryan <ryan@example.net>",
      to: [],
      cc: ["ryan@example.net", "observer@example.com"],
    });
    client.inboxes.messages.reply.mockResolvedValue({ messageId: "msg-reply-dedup" });

    const tool = createReplyEmailTool("avery@agentmail.test", agentDir, "abc123");
    await tool.execute("call-dedup", {
      messageId: "orig-msg",
      body: "hello",
      replyAll: true,
    });

    const [, , payload] = client.inboxes.messages.reply.mock.calls[0];
    expect(payload.to).toEqual(["Ryan <ryan@example.net>"]);
    // "ryan@example.net" in the original cc must be dropped since the email already appears in to.
    expect(payload.cc).toEqual(["observer@example.com", "avery+abc123@agentmail.test"]);
  });

  it("surfaces an error when reply-all cannot fetch the original message", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.get.mockRejectedValue(new Error("404 not found"));

    const tool = createReplyEmailTool("avery@agentmail.test", agentDir, "abc123");
    const result = await tool.execute("call-fetch-fail", {
      messageId: "missing-msg",
      body: "hi",
      replyAll: true,
    });

    expect(client.inboxes.messages.reply).not.toHaveBeenCalled();
    expect(result.details).toEqual({ error: true });
    expect(getText(result)).toContain("could not fetch original message for reply-all");
  });

  it("read_email exposes owner attachment metadata", async () => {
    const client = createAgentMailStub();
    client.inboxes.messages.get.mockResolvedValue({
      from: "Owner Example <owner@example.com>",
      to: ["avery@agentmail.test"],
      cc: [],
      subject: "Resume attached",
      createdAt: "2026-04-14T16:00:00.000Z",
      threadId: "thread-1",
      messageId: "msg-owner",
      extractedText: "Please review the attachment.",
      attachments: [
        {
          attachmentId: "att-1",
          filename: "resume.pdf",
          contentType: "application/pdf",
          size: 1234,
        },
      ],
    });

    const tool = createReadEmailTool("avery@agentmail.test", "owner@example.com");
    const result = await tool.execute("call-read-owner", { messageId: "msg-owner" });
    const text = getText(result);

    expect(text).toContain("Attachments (1):");
    expect(text).toContain("att-1 | resume.pdf | application/pdf | 1234 bytes");
    expect(result.details).toEqual(expect.objectContaining({
      attachments: {
        access: "owner",
        count: 1,
        senderEmail: "owner@example.com",
        items: [
          {
            attachmentId: "att-1",
            filename: "resume.pdf",
            contentType: "application/pdf",
            size: 1234,
          },
        ],
      },
    }));
  });

  it("read_email blocks non-owner attachment details", async () => {
    const client = createAgentMailStub();
    client.inboxes.messages.get.mockResolvedValue({
      from: "participant@example.com",
      to: ["avery@agentmail.test"],
      cc: [],
      subject: "Participant attachment",
      createdAt: "2026-04-14T16:00:00.000Z",
      threadId: "thread-2",
      messageId: "msg-participant",
      extractedText: "See attached.",
      attachments: [
        {
          attachmentId: "att-hidden",
          filename: "secret.pdf",
          contentType: "application/pdf",
          size: 222,
        },
      ],
    });

    const tool = createReadEmailTool("avery@agentmail.test", "owner@example.com");
    const result = await tool.execute("call-read-blocked", { messageId: "msg-participant" });
    const text = getText(result);

    expect(text).toContain("Attachments: 1 blocked (non-owner sender)");
    expect(text).not.toContain("secret.pdf");
    expect(text).not.toContain("att-hidden");
    expect(result.details).toEqual(expect.objectContaining({
      attachments: {
        access: "blocked",
        count: 1,
        blockedReason: "non_owner_sender",
        senderEmail: "participant@example.com",
      },
    }));
  });

  it("download_email_attachment saves an owner attachment to the default path", async () => {
    const agentDir = createTempAgentDir();
    const bytes = Buffer.from("owner attachment bytes", "utf-8");
    const client = createAgentMailStub();
    client.inboxes.messages.get.mockResolvedValue({
      from: "owner@example.com",
      to: ["avery@agentmail.test"],
      attachments: [
        {
          attachmentId: "att-1",
          filename: "resume final.pdf",
          contentType: "application/pdf",
          size: bytes.length,
        },
      ],
    });
    client.inboxes.messages.getAttachment.mockResolvedValue({
      attachmentId: "att-1",
      filename: "resume final.pdf",
      contentType: "application/pdf",
      downloadUrl: "https://download.test/att-1",
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: vi.fn().mockResolvedValue(createArrayBuffer(bytes)),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createDownloadEmailAttachmentTool("avery@agentmail.test", "owner@example.com", agentDir);
    const result = await tool.execute("call-download-default", {
      messageId: "msg-owner",
      attachmentId: "att-1",
    });

    const expectedPath = path.join("attachments", "att-1__resume_final.pdf");
    expect(fetchMock).toHaveBeenCalledWith("https://download.test/att-1");
    expect(fs.readFileSync(path.join(agentDir, expectedPath))).toEqual(bytes);
    expect(getText(result)).toContain(expectedPath);
    expect(result.details).toEqual({
      messageId: "msg-owner",
      attachmentId: "att-1",
      path: expectedPath,
      filename: "resume final.pdf",
      contentType: "application/pdf",
      size: bytes.length,
    });
  });

  it("download_email_attachment rejects non-owner messages", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.get.mockResolvedValue({
      from: "participant@example.com",
      to: ["avery@agentmail.test"],
      attachments: [
        {
          attachmentId: "att-1",
          filename: "blocked.pdf",
          contentType: "application/pdf",
          size: 10,
        },
      ],
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = createDownloadEmailAttachmentTool("avery@agentmail.test", "owner@example.com", agentDir);
    const result = await tool.execute("call-download-blocked", {
      messageId: "msg-blocked",
      attachmentId: "att-1",
    });

    expect(client.inboxes.messages.getAttachment).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getText(result)).toContain("only allowed for owner-sent emails");
    expect(result.details).toEqual(expect.objectContaining({ error: true }));
  });

  it("download_email_attachment rejects unknown attachment ids", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.get.mockResolvedValue({
      from: "owner@example.com",
      to: ["avery@agentmail.test"],
      attachments: [
        {
          attachmentId: "att-known",
          filename: "resume.pdf",
          contentType: "application/pdf",
          size: 10,
        },
      ],
    });

    const tool = createDownloadEmailAttachmentTool("avery@agentmail.test", "owner@example.com", agentDir);
    const result = await tool.execute("call-download-missing", {
      messageId: "msg-owner",
      attachmentId: "att-missing",
    });

    expect(client.inboxes.messages.getAttachment).not.toHaveBeenCalled();
    expect(getText(result)).toContain("Attachment att-missing was not found");
    expect(result.details).toEqual({
      error: true,
      messageId: "msg-owner",
      attachmentId: "att-missing",
    });
  });

  it("download_email_attachment rejects traversal in a caller-supplied path", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.get.mockResolvedValue({
      from: "owner@example.com",
      to: ["avery@agentmail.test"],
      attachments: [
        {
          attachmentId: "att-1",
          filename: "resume.pdf",
          contentType: "application/pdf",
          size: 10,
        },
      ],
    });
    client.inboxes.messages.getAttachment.mockResolvedValue({
      attachmentId: "att-1",
      filename: "resume.pdf",
      contentType: "application/pdf",
      downloadUrl: "https://download.test/att-1",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = createDownloadEmailAttachmentTool("avery@agentmail.test", "owner@example.com", agentDir);
    const result = await tool.execute("call-download-traversal", {
      messageId: "msg-owner",
      attachmentId: "att-1",
      path: "../escape.pdf",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getText(result)).toContain("Path traversal not allowed");
    expect(result.details).toEqual({ error: true });
  });

  it("filters child task emails to tagged threads only", async () => {
    createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.threads.list.mockResolvedValue({
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
    client.inboxes.messages.list.mockResolvedValue({
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

    const tool = createFilteredReadEmailsTool("avery@agentmail.test", "abc123");
    const result = await tool.execute("call-filtered", { limit: 10 });
    const textResult = getText(result);

    expect(textResult).toContain("Tagged");
    expect(textResult).not.toContain("Untagged");
  });
});

describe("sendOwnerNotification", () => {
  it("sends a plain-text email with no CC and returns the message id", async () => {
    const client = createAgentMailStub();
    client.inboxes.messages.send.mockResolvedValue({ messageId: "notif-1" });

    const messageId = await sendOwnerNotification({
      agentEmail: "avery@agentmail.test",
      ownerEmail: "owner@example.com",
      subject: "[Failed] Avery — Bootstrap ledger",
      body: "Task failed: abc-123\nError: API unreachable.",
    });

    expect(messageId).toBe("notif-1");
    expect(client.inboxes.messages.send).toHaveBeenCalledWith(
      "avery@agentmail.test",
      {
        to: ["owner@example.com"],
        subject: "[Failed] Avery — Bootstrap ledger",
        text: "Task failed: abc-123\nError: API unreachable.",
      },
    );
    // No CC field — owner replies route to the base inbox (root task)
    const call = client.inboxes.messages.send.mock.calls[0];
    const sentParams = call[1] as Record<string, unknown>;
    expect(sentParams.cc).toBeUndefined();
  });

  it("returns null when AgentMail throws — does not propagate the error", async () => {
    const client = createAgentMailStub();
    client.inboxes.messages.send.mockRejectedValue(new Error("AgentMail 503"));

    const messageId = await sendOwnerNotification({
      agentEmail: "avery@agentmail.test",
      ownerEmail: "owner@example.com",
      subject: "[Failed] test",
      body: "body",
    });

    expect(messageId).toBeNull();
  });

  it("accepts alternate message_id field name from AgentMail response", async () => {
    const client = createAgentMailStub();
    client.inboxes.messages.send.mockResolvedValue({ message_id: "notif-2" });

    const messageId = await sendOwnerNotification({
      agentEmail: "avery@agentmail.test",
      ownerEmail: "owner@example.com",
      subject: "[Escalated] test",
      body: "body",
    });

    expect(messageId).toBe("notif-2");
  });
});
