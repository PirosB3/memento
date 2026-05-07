import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDownloadEmailAttachmentTool,
  createReadEmailTool,
  createReplyEmailTool,
  createSendEmailTool,
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
  it("appends the agent signature to text and generates HTML fallback when only text was provided", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.send.mockResolvedValue({ messageId: "msg-sig-1" });

    const tool = createSendEmailTool("avery@agentmail.test", agentDir, {
      displayName: "Emma P.",
      description: "Inbox concierge for the Smith household.",
      profileImageUrl: "https://pub-example.test/pfps/emma.png",
    });
    await tool.execute("call-sig-1", {
      to: "person@example.com",
      subject: "Hello",
      body: "Hi there",
    });

    const [, sendParams] = client.inboxes.messages.send.mock.calls[0];
    expect(sendParams.text).toContain("Hi there");
    expect(sendParams.text).toContain("-- \nEmma P.\n");
    expect(sendParams.text).toContain("Inbox concierge for the Smith household.");
    expect(sendParams.html).toContain("Hi there");
    expect(sendParams.html).toContain('src="https://pub-example.test/pfps/emma.png"');
    expect(sendParams.html).toContain("Emma P.");
    expect(sendParams.html).toContain("Inbox concierge for the Smith household.");
  });

  it("appends the signature after caller-supplied HTML without dropping it", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.send.mockResolvedValue({ messageId: "msg-sig-2" });

    const tool = createSendEmailTool("avery@agentmail.test", agentDir, {
      displayName: "Emma P.",
      description: null,
      profileImageUrl: null,
    });
    await tool.execute("call-sig-2", {
      to: "person@example.com",
      subject: "Hello",
      body: "Text body",
      html: "<p>HTML body</p>",
    });

    const [, sendParams] = client.inboxes.messages.send.mock.calls[0];
    expect(sendParams.html?.indexOf("<p>HTML body</p>")).toBeGreaterThanOrEqual(0);
    expect(sendParams.html?.indexOf("Emma P.")).toBeGreaterThan(
      sendParams.html!.indexOf("<p>HTML body</p>"),
    );
    expect(sendParams.html).not.toContain("<img");
    expect(sendParams.text).toContain("Text body\n\n-- \nEmma P.");
  });

  it("includes the threadRef line in the signature when provided", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.send.mockResolvedValue({ messageId: "msg-ref" });

    const tool = createSendEmailTool("avery@agentmail.test", agentDir, {
      displayName: "Emma P.",
      description: null,
      profileImageUrl: null,
      threadRef: "demo-2026-05-07",
    });
    await tool.execute("call-ref", {
      to: "person@example.com",
      subject: "Hello",
      body: "Hi",
    });

    const [, sendParams] = client.inboxes.messages.send.mock.calls[0];
    expect(sendParams.text).toContain("\nref: demo-2026-05-07\n");
    expect(sendParams.html).toContain("ref: demo-2026-05-07");
  });

  it("skips signature injection when no body or html is provided", async () => {
    const agentDir = createTempAgentDir();
    fs.writeFileSync(path.join(agentDir, "note.txt"), "attached-only", "utf-8");
    const client = createAgentMailStub();
    client.inboxes.messages.send.mockResolvedValue({ messageId: "msg-sig-3" });

    const tool = createSendEmailTool("avery@agentmail.test", agentDir, {
      displayName: "Emma P.",
      description: "Helps you schedule meetings without the back-and-forth.",
      profileImageUrl: "https://pub-example.test/pfps/emma.png",
    });
    await tool.execute("call-sig-3", {
      to: "person@example.com",
      subject: "Hello",
      attachments: [{ path: "note.txt" }],
    });

    const [, sendParams] = client.inboxes.messages.send.mock.calls[0];
    expect(sendParams.text).toBeUndefined();
    expect(sendParams.html).toBeUndefined();
  });

  it("does not inject any tagged routing CC", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.send.mockResolvedValue({ messageId: "msg-no-tag" });

    const tool = createSendEmailTool("avery@agentmail.test", agentDir);
    await tool.execute("call-no-tag", {
      to: "person@example.com",
      subject: "Hello",
      body: "Hi there",
      cc: ["owner@example.com"],
    });

    expect(client.inboxes.messages.send).toHaveBeenCalledWith(
      "avery@agentmail.test",
      expect.objectContaining({
        cc: ["owner@example.com"],
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

  it("invokes the threadIdHook with the threadId from the send response", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.send.mockResolvedValue({ messageId: "msg-th-1", threadId: "thread-AAA" });

    const hook = vi.fn();
    const tool = createSendEmailTool("avery@agentmail.test", agentDir, undefined, hook);
    await tool.execute("call-hook", {
      to: "person@example.com",
      subject: "Hello",
      body: "Hi",
    });

    expect(hook).toHaveBeenCalledWith("thread-AAA");
    expect(client.inboxes.messages.get).not.toHaveBeenCalled();
  });

  it("falls back to messages.get when the send response omits threadId", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.send.mockResolvedValue({ messageId: "msg-th-2" });
    client.inboxes.messages.get.mockResolvedValue({ messageId: "msg-th-2", threadId: "thread-BBB" });

    const hook = vi.fn();
    const tool = createSendEmailTool("avery@agentmail.test", agentDir, undefined, hook);
    await tool.execute("call-hook-fallback", {
      to: "person@example.com",
      subject: "Hello",
      body: "Hi",
    });

    expect(client.inboxes.messages.get).toHaveBeenCalledWith("avery@agentmail.test", "msg-th-2");
    expect(hook).toHaveBeenCalledWith("thread-BBB");
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

  it("uses the native replyAll flag for replies (no manual reconstruction)", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.reply.mockResolvedValue({ messageId: "msg-reply", threadId: "thread-reply" });

    const tool = createReplyEmailTool("avery@agentmail.test", agentDir);
    await tool.execute("call-reply-all", {
      messageId: "orig-msg",
      body: "Reply body",
      replyAll: true,
    });

    expect(client.inboxes.messages.get).not.toHaveBeenCalled();
    expect(client.inboxes.messages.reply).toHaveBeenCalledWith(
      "avery@agentmail.test",
      "orig-msg",
      expect.objectContaining({
        text: "Reply body",
        replyAll: true,
      }),
    );
  });

  it("invokes the threadIdHook on a successful reply", async () => {
    const agentDir = createTempAgentDir();
    const client = createAgentMailStub();
    client.inboxes.messages.reply.mockResolvedValue({ messageId: "msg-r1", threadId: "thread-RRR" });

    const hook = vi.fn();
    const tool = createReplyEmailTool("avery@agentmail.test", agentDir, undefined, hook);
    await tool.execute("call-reply-hook", {
      messageId: "orig-msg",
      body: "Reply body",
    });

    expect(hook).toHaveBeenCalledWith("thread-RRR");
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
});
