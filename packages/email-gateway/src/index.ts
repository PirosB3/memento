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
  }) as Record<string, unknown>;

  const messages = (response.messages ?? response.data ?? response) as Record<string, unknown>[];
  if (!Array.isArray(messages) || messages.length === 0) return;

  log.info(`  [${agent.agentId}] Found ${messages.length} messages, checking for unprocessed inbound...`);

  // Filter to received messages only (skip sent)
  const inbound = messages.filter((m: Record<string, unknown>) => {
    const labels = m.labels as string[] | undefined;
    return labels?.includes("received");
  });

  if (inbound.length === 0) return;

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

    log.info(`New email for agent ${agent.agentId}: messageId=${messageId} from=${from} to=${JSON.stringify(toAddresses)} cc=${JSON.stringify(ccAddresses)}`);

    const outcome = await routeEmail(temporal, agent, { messageId, from, timestamp }, allAddresses);

    if (outcome.delivered) {
      await prisma.processedEmail.create({
        data: {
          messageId,
          inboxId: agent.agentEmail,
        },
      });
    }
  }
}

export async function routeEmail(
  temporal: Client,
  agent: { agentId: string; agentEmail: string; ownerEmail: string },
  msg: { messageId: string; from: string; timestamp: string },
  toAddresses: string[],
): Promise<{ delivered: boolean }> {
  const senderEmail = msg.from.includes("<")
    ? msg.from.match(/<(.+)>/)?.[1] ?? msg.from
    : msg.from;
  const isOwner = senderEmail.toLowerCase() === agent.ownerEmail.toLowerCase();
  const tag = parseTag(toAddresses, agent.agentEmail);

  try {
    if (tag && tag !== "root") {
      // Tagged email → route to specific child task workflow
      const task = await prisma.task.findUnique({ where: { tag } });

      if (task) {
        if (!(await isWorkflowRunning(temporal, `task-${task.taskId}`))) {
          log.info(`  → Deferring email for stopped task ${task.taskId} (will retry on restart)`);
          return { delivered: false };
        }

        const handle = temporal.workflow.getHandle(`task-${task.taskId}`);

        if (isOwner) {
          log.info(`  → Owner signal for task ${task.taskId} (messageId=${msg.messageId})`);
          await handle.signal(SIGNAL_OWNER, msg.messageId);
        } else {
          log.info(`  → Participant signal for task ${task.taskId} from ${senderEmail} (messageId=${msg.messageId})`);
          const inboundEmail: InboundEmail = {
            messageId: msg.messageId,
            sender: senderEmail,
            inboxId: agent.agentEmail,
            timestamp: msg.timestamp,
            tag,
          };
          await handle.signal(SIGNAL_EMAIL, inboundEmail);
        }
      } else {
        // Orphan tag → fall back to root task
        if (!(await isWorkflowRunning(temporal, `agent__${agent.agentId}__root`))) {
          log.info(`  → Deferring orphan-tag email because root workflow is stopped for agent ${agent.agentId} (will retry on restart)`);
          return { delivered: false };
        }

        log.info(`  → Orphan tag "${tag}", routing to root task for agent ${agent.agentId}`);
        const handle = temporal.workflow.getHandle(`agent__${agent.agentId}__root`);
        const inboundEmail: InboundEmail = {
          messageId: msg.messageId,
          sender: senderEmail,
          inboxId: agent.agentEmail,
          timestamp: msg.timestamp,
          tag,
        };
        await handle.signal(SIGNAL_EMAIL, inboundEmail);
      }
    } else {
      // No tag (or tag=root) → route to root task
      if (!(await isWorkflowRunning(temporal, `agent__${agent.agentId}__root`))) {
        log.info(`  → Deferring root email because root workflow is stopped for agent ${agent.agentId} (will retry on restart)`);
        return { delivered: false };
      }

      log.info(`  → Routing to root task for agent ${agent.agentId} from ${senderEmail}`);
      const handle = temporal.workflow.getHandle(`agent__${agent.agentId}__root`);
      if (isOwner) {
        await handle.signal(SIGNAL_OWNER, msg.messageId);
      } else {
        const inboundEmail: InboundEmail = {
          messageId: msg.messageId,
          sender: senderEmail,
          inboxId: agent.agentEmail,
          timestamp: msg.timestamp,
        };
        await handle.signal(SIGNAL_EMAIL, inboundEmail);
      }
    }
    log.info("  Signal sent successfully");
    return { delivered: true };
  } catch (error) {
    log.error(`  Failed to send signal for agent ${agent.agentId}:`, error);
    return { delivered: false };
  }
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
