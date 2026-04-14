import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { Client, Connection } from "@temporalio/client";
import { AgentMailClient } from "agentmail";
import { prisma, SIGNAL_EMAIL, SIGNAL_OWNER, createLogger, getTemporalAddress } from "@summon/shared";
import type { InboundEmail } from "@summon/shared";

const POLL_INTERVAL_MS = 15_000;
const log = createLogger("email-gateway");

interface PendingInboundMessage {
  messageId: string;
  from: string;
  timestamp: string;
  senderEmail: string;
  isOwner: boolean;
  tag: string | null;
}

interface SignalBatch {
  workflowId: string;
  signalType: "email" | "owner";
  tag?: string;
  messageIds: string[];
  senders: string[];
  latestTimestamp: string;
}

async function isWorkflowRunning(temporal: Client, workflowId: string): Promise<boolean> {
  try {
    const handle = temporal.workflow.getHandle(workflowId);
    const description = await handle.describe();
    return description.status.name === "RUNNING";
  } catch {
    return false;
  }
}

export async function main() {
  log.info("Starting email gateway (polling mode)...");

  const connection = await Connection.connect({ address: getTemporalAddress() });
  const temporal = new Client({ connection });
  log.info("Connected to Temporal");

  const agentmail = new AgentMailClient({
    apiKey: process.env.AGENTMAIL_API_KEY!,
  });

  log.info(`Polling every ${POLL_INTERVAL_MS / 1000}s for new emails...`);

  while (true) {
    try {
      await pollAllInboxes(agentmail, temporal);
    } catch (err) {
      log.error("Poll cycle error:", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function pollAllInboxes(agentmail: AgentMailClient, temporal: Client) {
  const agents = await prisma.agent.findMany({
    where: {
      status: { in: ["IDLE", "RUNNING"] },
    },
  });

  for (const agent of agents) {
    try {
      if (!(await isWorkflowRunning(temporal, `agent__${agent.agentId}__root`))) {
        log.info(`  [${agent.agentId}] Skipping inbox poll because root workflow is stopped`);
        continue;
      }
      await pollInbox(agentmail, temporal, agent);
    } catch (err) {
      log.error(`Error polling inbox for agent ${agent.agentId}:`, err);
    }
  }
}

/**
 * Parse +tag from recipient address.
 * E.g. "john+abc123@agentmail.to" → "abc123"
 */
export function parseTag(toAddresses: string[], agentEmail: string): string | null {
  const [localPart, domain] = agentEmail.split("@");
  const escapedLocal = localPart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedLocal}\\+([^@]+)@${escapedDomain}$`, "i");

  for (const addr of toAddresses) {
    // Extract email from "Name <email>" format
    const normalized = addr.includes("<")
      ? addr.match(/<(.+)>/)?.[1] ?? addr
      : addr;
    const match = normalized.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function isSelfSentEmail(fromField: string, agentEmail: string): boolean {
  return fromField
    .toLowerCase()
    .includes(agentEmail.split("@")[0].toLowerCase() + "@");
}

export async function pollInbox(
  agentmail: AgentMailClient,
  temporal: Client,
  agent: { agentId: string; agentEmail: string; ownerEmail: string },
) {
  // Fetch recent messages from agentmail
  const response = await agentmail.inboxes.messages.list(agent.agentEmail, {
    limit: 20,
  }) as unknown as Record<string, unknown>;

  const messages = (response.messages ?? response.data ?? response) as Record<string, unknown>[];
  if (!Array.isArray(messages) || messages.length === 0) return;

  log.info(`  [${agent.agentId}] Found ${messages.length} messages, checking for unprocessed inbound...`);

  // Filter to received messages only (skip sent)
  const inbound = messages.filter((m: Record<string, unknown>) => {
    const labels = m.labels as string[] | undefined;
    return labels?.includes("received");
  });

  if (inbound.length === 0) return;

  const pendingMessages: PendingInboundMessage[] = [];

  for (const msg of inbound) {
    const messageId = (msg as Record<string, unknown>).messageId as string
      ?? (msg as Record<string, unknown>).message_id as string;

    if (!messageId) continue;

    // Skip emails sent by the agent itself (prevents self-wake loops)
    const fromField = ((msg as Record<string, unknown>).from as string ?? "").toLowerCase();
    if (isSelfSentEmail(fromField, agent.agentEmail)) {
      continue;
    }

    // Check if already processed
    const existing = await prisma.processedEmail.findUnique({
      where: { messageId },
    });
    if (existing) continue;

    const from = (msg as Record<string, unknown>).from as string ?? "";
    const timestamp = (msg as Record<string, unknown>).timestamp as string
      ?? (msg as Record<string, unknown>).created_at as string
      ?? new Date().toISOString();

    // Extract "to" and "cc" addresses for tag parsing
    const toRaw = (msg as Record<string, unknown>).to;
    const ccRaw = (msg as Record<string, unknown>).cc;
    const toAddresses: string[] = Array.isArray(toRaw)
      ? toRaw.map(String)
      : typeof toRaw === "string"
        ? [toRaw]
        : [];
    const ccAddresses: string[] = Array.isArray(ccRaw)
      ? ccRaw.map(String)
      : typeof ccRaw === "string"
        ? [ccRaw]
        : [];
    const allAddresses = [...toAddresses, ...ccAddresses];
    const senderEmail = from.includes("<")
      ? from.match(/<(.+)>/)?.[1] ?? from
      : from;
    const isOwner = senderEmail.toLowerCase() === agent.ownerEmail.toLowerCase();
    const tag = parseTag(allAddresses, agent.agentEmail);

    log.info(`New email for agent ${agent.agentId}: messageId=${messageId} from=${from} to=${JSON.stringify(toAddresses)} cc=${JSON.stringify(ccAddresses)}`);
    pendingMessages.push({ messageId, from, timestamp, senderEmail, isOwner, tag });
  }

  if (pendingMessages.length === 0) return;

  const batchingResult = await routeEmailBatches(temporal, agent, pendingMessages);
  if (batchingResult.deliveredMessageIds.length === 0) return;

  await prisma.processedEmail.createMany({
    data: batchingResult.deliveredMessageIds.map((messageId) => ({
      messageId,
      inboxId: agent.agentEmail,
    })),
    skipDuplicates: true,
  });
}

export async function routeEmailBatches(
  temporal: Client,
  agent: { agentId: string; agentEmail: string; ownerEmail: string },
  messages: PendingInboundMessage[],
): Promise<{ deliveredMessageIds: string[] }> {
  const batchesByKey = new Map<string, SignalBatch>();
  const deliveredMessageIds: string[] = [];

  for (const msg of messages) {
    const route = await resolveSignalBatchRoute(temporal, agent, msg);
    if (!route) continue;

    const key = `${route.workflowId}:${route.signalType}`;
    const existing = batchesByKey.get(key);

    if (!existing) {
      batchesByKey.set(key, {
        workflowId: route.workflowId,
        signalType: route.signalType,
        tag: route.tag,
        messageIds: [msg.messageId],
        senders: [msg.senderEmail],
        latestTimestamp: msg.timestamp,
      });
      continue;
    }

    existing.messageIds.push(msg.messageId);
    existing.senders.push(msg.senderEmail);
    if (new Date(msg.timestamp).getTime() > new Date(existing.latestTimestamp).getTime()) {
      existing.latestTimestamp = msg.timestamp;
    }
  }

  for (const batch of batchesByKey.values()) {
    try {
      const handle = temporal.workflow.getHandle(batch.workflowId);
      if (batch.signalType === "owner") {
        const payload = `inline:${JSON.stringify({
          source: "owner",
          message: `${batch.messageIds.length} owner email(s) received in latest poll batch`,
          messageIds: batch.messageIds,
        })}`;
        log.info(`  → Owner batch signal for ${batch.workflowId} (${batch.messageIds.length} message(s))`);
        await handle.signal(SIGNAL_OWNER, payload);
      } else {
        const inboundEmail: InboundEmail = {
          messageId: batch.messageIds[0],
          sender: batch.senders[0],
          inboxId: agent.agentEmail,
          timestamp: batch.latestTimestamp,
          tag: batch.tag,
          batchMessageIds: batch.messageIds,
          batchSenders: batch.senders,
        };
        log.info(`  → Participant batch signal for ${batch.workflowId} (${batch.messageIds.length} message(s))`);
        await handle.signal(SIGNAL_EMAIL, inboundEmail);
      }
      deliveredMessageIds.push(...batch.messageIds);
    } catch (error) {
      log.error(`  Failed to send batch signal for ${batch.workflowId}:`, error);
    }
  }

  return { deliveredMessageIds };
}

async function resolveSignalBatchRoute(
  temporal: Client,
  agent: { agentId: string; agentEmail: string; ownerEmail: string },
  msg: PendingInboundMessage,
): Promise<{ workflowId: string; signalType: "email" | "owner"; tag?: string } | null> {
  if (msg.tag && msg.tag !== "root") {
    const task = await prisma.task.findUnique({ where: { tag: msg.tag } });

    if (task) {
      const workflowId = `task-${task.taskId}`;
      if (!(await isWorkflowRunning(temporal, workflowId))) {
        log.info(`  → Deferring email for stopped task ${task.taskId} (will retry on restart)`);
        return null;
      }
      return {
        workflowId,
        signalType: msg.isOwner ? "owner" : "email",
        tag: msg.tag,
      };
    }

    const rootWorkflowId = `agent__${agent.agentId}__root`;
    if (!(await isWorkflowRunning(temporal, rootWorkflowId))) {
      log.info(`  → Deferring orphan-tag email because root workflow is stopped for agent ${agent.agentId} (will retry on restart)`);
      return null;
    }
    log.info(`  → Orphan tag "${msg.tag}", routing to root task for agent ${agent.agentId}`);
    return {
      workflowId: rootWorkflowId,
      signalType: "email",
      tag: msg.tag,
    };
  }

  const rootWorkflowId = `agent__${agent.agentId}__root`;
  if (!(await isWorkflowRunning(temporal, rootWorkflowId))) {
    log.info(`  → Deferring root email because root workflow is stopped for agent ${agent.agentId} (will retry on restart)`);
    return null;
  }

  return {
    workflowId: rootWorkflowId,
    signalType: msg.isOwner ? "owner" : "email",
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log.error("Email gateway failed:", err);
    process.exit(1);
  });
}
