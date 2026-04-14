import { Type } from "@sinclair/typebox";
import { AgentMailClient } from "agentmail";
import fs from "fs";
import path from "path";
import type { AgentTool } from "../../pi-types.js";

interface AgentMailLike {
  inboxes: {
    messages: {
      send: (inboxId: string, params: Record<string, unknown>) => Promise<unknown>;
      reply: (inboxId: string, messageId: string, params: Record<string, unknown>) => Promise<unknown>;
      get: (inboxId: string, messageId: string) => Promise<unknown>;
      list: (inboxId: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    threads: {
      list: (inboxId: string, params: Record<string, unknown>) => Promise<unknown>;
    };
  };
}

let agentmailClient: AgentMailLike | null = null;

function getAgentMailClient(): AgentMailLike {
  if (!agentmailClient) {
    agentmailClient = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
  }
  return agentmailClient;
}

export function setAgentMailClientForTests(client: AgentMailLike | null): void {
  agentmailClient = client;
}

export function addTag(email: string, tag: string): string {
  const [local, domain] = email.split("@");
  return `${local}+${tag}@${domain}`;
}

function createSelfAddressMatcher(agentEmail: string): (addr: string) => boolean {
  const [local, domain] = agentEmail.toLowerCase().split("@");
  const base = `${local}@${domain}`;
  const taggedPrefix = `${local}+`;
  const taggedSuffix = `@${domain}`;
  return (addr: string) => {
    const lc = addr.trim().toLowerCase();
    if (!lc) return false;
    if (lc === base) return true;
    return lc.startsWith(taggedPrefix) && lc.endsWith(taggedSuffix);
  };
}

type AttachmentInput = {
  path: string;
  filename?: string;
  contentType?: string;
  contentDisposition?: "attachment" | "inline";
  contentId?: string;
};

type SendEmailParams = {
  to: string | string[];
  subject: string;
  body?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: AttachmentInput[];
};

type ReplyEmailParams = {
  messageId: string;
  body?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  replyAll?: boolean;
  attachments?: AttachmentInput[];
};

type OutgoingEmailInput = {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  replyAll?: boolean;
  attachments?: Record<string, unknown>[];
};

const attachmentInputSchema = Type.Object({
  path: Type.String({ description: "Relative path to a file in your working directory." }),
  filename: Type.Optional(Type.String({ description: "Optional override for the attachment filename." })),
  contentType: Type.Optional(Type.String({ description: "Optional MIME type, such as image/png or text/plain." })),
  contentDisposition: Type.Optional(Type.Union([
    Type.Literal("attachment"),
    Type.Literal("inline"),
  ], { description: "How the attachment should be presented to recipients." })),
  contentId: Type.Optional(Type.String({ description: "Optional content ID for inline HTML references." })),
});

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAddressList(value: string | string[] | undefined): string[] {
  const rawList = value === undefined
    ? []
    : Array.isArray(value)
      ? value
      : [value];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of rawList) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function isWithinDir(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeAttachments(agentDir: string, attachments?: AttachmentInput[]): Record<string, unknown>[] {
  if (!attachments?.length) {
    return [];
  }

  return attachments.map((attachment) => {
    const relativePath = normalizeString(attachment.path);
    if (!relativePath) {
      throw new Error("Attachment path is required.");
    }

    const fullPath = path.resolve(agentDir, relativePath);
    if (!isWithinDir(agentDir, fullPath)) {
      throw new Error(`Attachment path traversal not allowed: ${attachment.path}`);
    }

    let content: Buffer;
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        throw new Error("not a file");
      }
      content = fs.readFileSync(fullPath);
    } catch {
      throw new Error(`Attachment file not found or unreadable: ${attachment.path}`);
    }

    const normalizedAttachment: Record<string, unknown> = {
      filename: normalizeString(attachment.filename) ?? path.basename(fullPath),
      content: content.toString("base64"),
    };

    const contentType = normalizeString(attachment.contentType);
    if (contentType) {
      normalizedAttachment.contentType = contentType;
    }

    if (attachment.contentDisposition) {
      normalizedAttachment.contentDisposition = attachment.contentDisposition;
    }

    const contentId = normalizeString(attachment.contentId);
    if (contentId) {
      normalizedAttachment.contentId = contentId;
    }

    return normalizedAttachment;
  });
}

function buildEmailPayload(
  rawParams: SendEmailParams | ReplyEmailParams,
  options: {
    mode: "send" | "reply";
    agentDir: string;
    taggedEmail?: string | null;
  },
): OutgoingEmailInput {
  const text = normalizeString(rawParams.body);
  const html = normalizeString(rawParams.html);
  const attachments = normalizeAttachments(options.agentDir, rawParams.attachments);

  if (!text && !html && attachments.length === 0) {
    throw new Error("Provide at least one of body, html, or attachments.");
  }

  const cc = normalizeAddressList(rawParams.cc);
  if (options.taggedEmail) {
    cc.push(options.taggedEmail);
  }

  const payload: OutgoingEmailInput = {
    text,
    html,
    cc: normalizeAddressList(cc),
    bcc: normalizeAddressList(rawParams.bcc),
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  if (options.mode === "send") {
    const sendParams = rawParams as SendEmailParams;
    const to = normalizeAddressList(sendParams.to);
    const subject = normalizeString(sendParams.subject);
    if (!subject) {
      throw new Error("Subject is required.");
    }
    if (to.length === 0) {
      throw new Error("Provide at least one recipient in to.");
    }
    payload.to = to;
    payload.subject = subject;
  } else {
    const replyParams = rawParams as ReplyEmailParams;
    if (replyParams.replyAll) {
      payload.replyAll = true;
    }
  }

  if (!payload.cc?.length) {
    delete payload.cc;
  }
  if (!payload.bcc?.length) {
    delete payload.bcc;
  }

  return payload;
}

function formatAttachmentSummary(attachments?: AttachmentInput[]): string {
  if (!attachments?.length) {
    return "no attachments";
  }

  const names = attachments.map((attachment) => normalizeString(attachment.filename) ?? attachment.path);
  return `${attachments.length} attachment${attachments.length === 1 ? "" : "s"} (${names.join(", ")})`;
}

// ============================================================================
// SEND EMAIL — root sends from base, child auto-CCs its +tag address for routing
// ============================================================================

export function createSendEmailTool(agentEmail: string, agentDir: string, tag?: string): AgentTool {
  const inboxId = agentEmail;
  const taggedEmail = tag ? addTag(agentEmail, tag) : null;

  return {
    name: "send_email",
    label: "Send Email",
    description:
      "Send a NEW email (starts a new thread). Only use this for first contact. For replies to existing emails, use reply_email instead.",
    parameters: Type.Object({
      to: Type.Union([
        Type.String({ description: "Recipient email address." }),
        Type.Array(Type.String(), { description: "Recipient email addresses." }),
      ]),
      subject: Type.String({ description: "Email subject line" }),
      body: Type.Optional(Type.String({ description: "Plain-text email body." })),
      html: Type.Optional(Type.String({ description: "Optional HTML version of the email body." })),
      cc: Type.Optional(Type.Array(Type.String(), { description: "CC email addresses. Always CC the owner on emails to participants." })),
      bcc: Type.Optional(Type.Array(Type.String(), { description: "BCC email addresses." })),
      attachments: Type.Optional(Type.Array(attachmentInputSchema, { description: "Files to attach from your workspace." })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const p = params as SendEmailParams;
        const agentmail = getAgentMailClient();
        const sendParams = buildEmailPayload(p, { mode: "send", agentDir, taggedEmail });
        const result = await agentmail.inboxes.messages.send(inboxId, sendParams) as Record<string, unknown>;
        const toList = normalizeAddressList(p.to);
        const ccList = normalizeAddressList(sendParams.cc as string[] | undefined);
        const bccList = normalizeAddressList(sendParams.bcc as string[] | undefined);
        const recipientParts = [`to ${toList.join(", ")}`];
        if (ccList.length) {
          recipientParts.push(`cc ${ccList.join(", ")}`);
        }
        if (bccList.length) {
          recipientParts.push(`bcc ${bccList.join(", ")}`);
        }
        return {
          content: [{
            type: "text" as const,
            text: `Email sent successfully (${recipientParts.join("; ")}; ${formatAttachmentSummary(p.attachments)}). Message ID: ${result.messageId ?? result.message_id ?? "unknown"}`,
          }],
          details: { messageId: result.messageId ?? result.message_id },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to send email: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

// ============================================================================
// REPLY EMAIL
// ============================================================================

export function createReplyEmailTool(agentEmail: string, agentDir: string, tag?: string): AgentTool {
  const inboxId = agentEmail;
  const taggedEmail = tag ? addTag(agentEmail, tag) : null;
  const isSelfAddress = createSelfAddressMatcher(agentEmail);

  return {
    name: "reply_email",
    label: "Reply Email",
    description:
      "Reply to an existing email in-thread. Preserves threading. Always prefer this over send_email when responding.",
    parameters: Type.Object({
      messageId: Type.String({ description: "The message ID to reply to" }),
      body: Type.Optional(Type.String({ description: "Plain-text reply body." })),
      html: Type.Optional(Type.String({ description: "Optional HTML version of the reply body." })),
      cc: Type.Optional(Type.Array(Type.String(), { description: "CC email addresses." })),
      bcc: Type.Optional(Type.Array(Type.String(), { description: "BCC email addresses." })),
      replyAll: Type.Optional(Type.Boolean({ description: "Reply to all original recipients instead of the sender only." })),
      attachments: Type.Optional(Type.Array(attachmentInputSchema, { description: "Files to attach from your workspace." })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const p = params as ReplyEmailParams;
        const agentmail = getAgentMailClient();

        let replyParams: OutgoingEmailInput;

        if (p.replyAll && taggedEmail) {
          // AgentMail rejects replyAll + explicit cc, but child tasks must inject
          // their +tag into cc for routing. Construct reply-all recipients manually
          // and call reply() without the replyAll flag. Threading is preserved
          // because messageId still drives In-Reply-To/References.
          let original: Record<string, unknown>;
          try {
            original = await agentmail.inboxes.messages.get(inboxId, p.messageId) as Record<string, unknown>;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(`could not fetch original message for reply-all: ${reason}`);
          }

          const origFrom = typeof original.from === "string" ? original.from : "";
          const origTo = Array.isArray(original.to) ? (original.to as string[]) : [];
          const origCc = Array.isArray(original.cc) ? (original.cc as string[]) : [];

          let toList = normalizeAddressList([origFrom]).filter((a) => !isSelfAddress(a));
          let ccPool = normalizeAddressList([...origTo, ...origCc]).filter((a) => !isSelfAddress(a));

          // Replying to own sent message: fall back so someone still receives it.
          if (toList.length === 0 && ccPool.length > 0) {
            toList = [ccPool[0]];
            ccPool = ccPool.slice(1);
          }

          const toKeys = new Set(toList.map((a) => a.toLowerCase()));
          const mergedCc = [
            ...ccPool.filter((a) => !toKeys.has(a.toLowerCase())),
            ...normalizeAddressList(p.cc).filter((a) => !isSelfAddress(a) && !toKeys.has(a.toLowerCase())),
            taggedEmail,
          ];

          replyParams = buildEmailPayload(
            { ...p, replyAll: false, cc: mergedCc },
            { mode: "reply", agentDir, taggedEmail: null },
          );
          replyParams.to = toList;
        } else {
          replyParams = buildEmailPayload(p, { mode: "reply", agentDir, taggedEmail });
        }

        const result = await agentmail.inboxes.messages.reply(inboxId, p.messageId, replyParams) as Record<string, unknown>;
        const ccList = normalizeAddressList(replyParams.cc as string[] | undefined);
        const bccList = normalizeAddressList(replyParams.bcc as string[] | undefined);
        const recipientParts = [];
        if (p.replyAll) {
          recipientParts.push("reply-all");
        }
        if (ccList.length) {
          recipientParts.push(`cc ${ccList.join(", ")}`);
        }
        if (bccList.length) {
          recipientParts.push(`bcc ${bccList.join(", ")}`);
        }
        return {
          content: [{
            type: "text" as const,
            text: `Reply sent successfully${recipientParts.length ? ` (${recipientParts.join("; ")}; ${formatAttachmentSummary(p.attachments)})` : ` (${formatAttachmentSummary(p.attachments)})`}. Message ID: ${result.messageId ?? result.message_id ?? "unknown"}`,
          }],
          details: { messageId: result.messageId ?? result.message_id },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to reply: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

// ============================================================================
// READ EMAIL (by ID — same for root and child)
// ============================================================================

export function createReadEmailTool(agentEmail: string): AgentTool {
  const inboxId = agentEmail;

  return {
    name: "read_email",
    label: "Read Email",
    description: "Read the full contents of a specific email by its message ID.",
    parameters: Type.Object({
      messageId: Type.String({ description: "The message ID to read" }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const p = params as { messageId: string };
        const agentmail = getAgentMailClient();
        const msg = await agentmail.inboxes.messages.get(inboxId, p.messageId) as Record<string, unknown>;
        const body = (msg.extractedText ?? msg.text ?? "") as string;
        const formatted = [
          `From: ${msg.from ?? "unknown"}`,
          `To: ${JSON.stringify(msg.to)}`,
          msg.cc ? `CC: ${JSON.stringify(msg.cc)}` : null,
          `Subject: ${msg.subject ?? "(no subject)"}`,
          `Date: ${msg.createdAt ?? msg.timestamp ?? "unknown"}`,
          `Thread: ${msg.threadId ?? "none"}`,
          `Message ID: ${msg.messageId ?? p.messageId}`,
          ``,
          body || "(empty body)",
        ].filter(Boolean).join("\n");
        return {
          content: [{ type: "text" as const, text: formatted }],
          details: { messageId: p.messageId, threadId: msg.threadId },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to read email: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

// ============================================================================
// READ EMAILS — root sees all, child filtered by +tag in thread recipients
// ============================================================================

export function createReadEmailsTool(agentEmail: string): AgentTool {
  const inboxId = agentEmail;

  return {
    name: "read_emails",
    label: "Read Emails",
    description: "Read recent emails in the inbox. Returns the latest messages.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max messages to return (default 10)" })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const p = params as { limit?: number };
        const agentmail = getAgentMailClient();
        const response = await agentmail.inboxes.messages.list(inboxId, { limit: p.limit ?? 10 }) as Record<string, unknown>;
        const messages = (response.messages ?? response.data ?? []) as Record<string, unknown>[];
        const formatted = messages
          .map((m) =>
            `From: ${m.from ?? "unknown"}\nTo: ${JSON.stringify(m.to)}\nCC: ${JSON.stringify(m.cc)}\nSubject: ${m.subject ?? "(no subject)"}\nLabels: ${JSON.stringify(m.labels)}\nDate: ${m.createdAt ?? m.created_at ?? "unknown"}\nMessage ID: ${m.messageId ?? m.message_id}\nThread: ${m.threadId ?? m.thread_id ?? "none"}`)
          .join("\n---\n");
        return {
          content: [{ type: "text" as const, text: formatted || "No messages found." }],
          details: { count: messages.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to read emails: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

/**
 * Filtered version for child tasks — only shows emails from threads
 * where the +tag address appears in recipients or senders.
 */
export function createFilteredReadEmailsTool(agentEmail: string, tag: string): AgentTool {
  const inboxId = agentEmail;
  const taggedEmail = addTag(agentEmail, tag).toLowerCase();

  return {
    name: "read_emails",
    label: "Read Emails",
    description: "Read recent emails for this task. Only shows emails related to your task.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max messages to return (default 10)" })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const p = params as { limit?: number };
        const agentmail = getAgentMailClient();
        // Fetch threads and find ones that involve our +tag address
        const threadResponse = await agentmail.inboxes.threads.list(inboxId, { limit: 50 }) as Record<string, unknown>;
        const threads = (threadResponse.threads ?? threadResponse.data ?? []) as Record<string, unknown>[];

        const myThreadIds = new Set<string>();
        for (const t of threads) {
          const recipients = (t.recipients as string[] ?? []).map((r: string) => r.toLowerCase());
          const senders = (t.senders as string[] ?? []).map((s: string) => s.toLowerCase());
          const all = [...recipients, ...senders];
          if (all.some((addr) => addr.includes(taggedEmail))) {
            myThreadIds.add((t.threadId ?? t.thread_id) as string);
          }
        }

        // Fetch messages and filter to our threads
        const msgResponse = await agentmail.inboxes.messages.list(inboxId, { limit: 50 }) as Record<string, unknown>;
        const allMessages = (msgResponse.messages ?? msgResponse.data ?? []) as Record<string, unknown>[];
        const filtered = allMessages
          .filter((m) => myThreadIds.has((m.threadId ?? m.thread_id) as string))
          .slice(0, p.limit ?? 10);

        const formatted = filtered
          .map((m) =>
            `From: ${m.from ?? "unknown"}\nTo: ${JSON.stringify(m.to)}\nCC: ${JSON.stringify(m.cc)}\nSubject: ${m.subject ?? "(no subject)"}\nLabels: ${JSON.stringify(m.labels)}\nDate: ${m.createdAt ?? m.created_at ?? "unknown"}\nMessage ID: ${m.messageId ?? m.message_id}\nThread: ${m.threadId ?? m.thread_id ?? "none"}`)
          .join("\n---\n");
        return {
          content: [{ type: "text" as const, text: formatted || "No messages found for this task." }],
          details: { count: filtered.length, totalThreads: myThreadIds.size },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to read emails: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

// ============================================================================
// LIST THREADS — root sees all, child filtered
// ============================================================================

export function createListThreadsTool(agentEmail: string): AgentTool {
  const inboxId = agentEmail;

  return {
    name: "list_threads",
    label: "List Threads",
    description: "List email threads in the inbox.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max threads to return (default 10)" })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const p = params as { limit?: number };
        const agentmail = getAgentMailClient();
        const response = await agentmail.inboxes.threads.list(inboxId, { limit: p.limit ?? 10 }) as Record<string, unknown>;
        const threads = (response.threads ?? response.data ?? []) as Record<string, unknown>[];
        const formatted = threads
          .map((t) =>
            `Thread: ${t.threadId ?? t.thread_id}\nSubject: ${t.subject ?? "(no subject)"}\nSenders: ${JSON.stringify(t.senders)}\nRecipients: ${JSON.stringify(t.recipients)}\nMessages: ${t.messageCount ?? t.message_count ?? 0}\nUpdated: ${t.updatedAt ?? t.updated_at ?? "unknown"}`)
          .join("\n---\n");
        return {
          content: [{ type: "text" as const, text: formatted || "No threads found." }],
          details: { count: threads.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to list threads: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

export function createFilteredListThreadsTool(agentEmail: string, tag: string): AgentTool {
  const inboxId = agentEmail;
  const taggedEmail = addTag(agentEmail, tag).toLowerCase();

  return {
    name: "list_threads",
    label: "List Threads",
    description: "List email threads for this task.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max threads to return (default 10)" })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const p = params as { limit?: number };
        const agentmail = getAgentMailClient();
        const response = await agentmail.inboxes.threads.list(inboxId, { limit: 50 }) as Record<string, unknown>;
        const threads = (response.threads ?? response.data ?? []) as Record<string, unknown>[];

        const filtered = threads.filter((t) => {
          const recipients = (t.recipients as string[] ?? []).map((r: string) => r.toLowerCase());
          const senders = (t.senders as string[] ?? []).map((s: string) => s.toLowerCase());
          return [...recipients, ...senders].some((addr) => addr.includes(taggedEmail));
        }).slice(0, p.limit ?? 10);

        const formatted = filtered
          .map((t) =>
            `Thread: ${t.threadId ?? t.thread_id}\nSubject: ${t.subject ?? "(no subject)"}\nSenders: ${JSON.stringify(t.senders)}\nRecipients: ${JSON.stringify(t.recipients)}\nMessages: ${t.messageCount ?? t.message_count ?? 0}\nUpdated: ${t.updatedAt ?? t.updated_at ?? "unknown"}`)
          .join("\n---\n");
        return {
          content: [{ type: "text" as const, text: formatted || "No threads found for this task." }],
          details: { count: filtered.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to list threads: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}
