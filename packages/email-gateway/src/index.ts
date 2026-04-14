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

/**
 * A parsed inbound message ready for routing. `isOwner` and `tag` are resolved
 * once here so the routing step doesn't need to re-parse.
 */
interface PendingInboundMessage {
  messageId: string;
  timestamp: string;
  senderEmail: string;
  isOwner: boolean;
  tag: string | null;
}

/**
 * Accumulated batch of participant emails headed for the same workflow.
 * Owner emails are NOT batched — see `deliverMessages` for why.
 */
interface ParticipantBatch {
  workflowId: string;
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

/**
 * Poll an agent's inbox for new messages and dispatch them to the right
 * Temporal workflow. Participant emails destined for the same workflow are
 * batched into a single `on_email` signal so the agent wakes once per poll
 * cycle instead of once per message. Owner emails are delivered one-per-signal
 * because the worker's owner-wake path expects a deterministic messageId.
 */
export async function pollInbox(
  agentmail: AgentMailClient,
  temporal: Client,
  agent: { agentId: string; agentEmail: string; ownerEmail: string },
) {
  const response = await agentmail.inboxes.messages.list(agent.agentEmail, {
    limit: 20,
  }) as unknown as Record<string, unknown>;

  const messages = (response.messages ?? response.data ?? response) as Record<string, unknown>[];
  if (!Array.isArray(messages) || messages.length === 0) return;

  const pending = await collectPendingMessages(messages, agent);
  if (pending.length === 0) return;

  log.info(`  [${agent.agentId}] Dispatching ${pending.length} new message(s)`);

  const deliveredMessageIds = await deliverMessages(temporal, agent, pending);
  if (deliveredMessageIds.length === 0) return;

  await prisma.processedEmail.createMany({
    data: deliveredMessageIds.map((messageId) => ({
      messageId,
      inboxId: agent.agentEmail,
    })),
    skipDuplicates: true,
  });
}

/**
 * Walk the raw agentmail message list, skip anything we've already handled,
 * and return parsed `PendingInboundMessage`s ready for routing. We filter out:
 *   - sent messages (label != "received")
 *   - messages the agent sent to itself (would cause self-wake loops)
 *   - messages we've already recorded in `processedEmails`
 */
async function collectPendingMessages(
  messages: Record<string, unknown>[],
  agent: { agentEmail: string; ownerEmail: string },
): Promise<PendingInboundMessage[]> {
  const pending: PendingInboundMessage[] = [];

  for (const msg of messages) {
    const labels = msg.labels as string[] | undefined;
    if (!labels?.includes("received")) continue;

    const messageId = (msg.messageId as string) ?? (msg.message_id as string);
    if (!messageId) continue;

    const from = (msg.from as string) ?? "";
    if (isSelfSentEmail(from.toLowerCase(), agent.agentEmail)) continue;

    const existing = await prisma.processedEmail.findUnique({ where: { messageId } });
    if (existing) continue;

    const timestamp = (msg.timestamp as string)
      ?? (msg.created_at as string)
      ?? new Date().toISOString();

    const toAddresses = coerceAddressList(msg.to);
    const ccAddresses = coerceAddressList(msg.cc);

    // Agentmail returns `from` either as a bare address ("a@b.com") or as a
    // display-name form ("Name <a@b.com>"). Extract the bare address so we can
    // reliably compare against `ownerEmail` and use it in wake metadata.
    const senderEmail = from.includes("<")
      ? from.match(/<(.+)>/)?.[1] ?? from
      : from;

    pending.push({
      messageId,
      timestamp,
      senderEmail,
      isOwner: senderEmail.toLowerCase() === agent.ownerEmail.toLowerCase(),
      tag: parseTag([...toAddresses, ...ccAddresses], agent.agentEmail),
    });
  }

  return pending;
}

function coerceAddressList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return [raw];
  return [];
}

/**
 * Route pending messages to their target workflows. Owner emails are signalled
 * individually (one `SIGNAL_OWNER` per message) because the worker's owner-wake
 * handler needs a concrete messageId to tell the agent which email to read.
 * Participant emails headed for the same workflow are grouped into a single
 * `SIGNAL_EMAIL` batch so the agent wakes once per poll cycle.
 *
 * Returns the list of messageIds that were successfully delivered (and should
 * therefore be marked as processed). Messages whose target workflow is stopped
 * are deferred — they stay unprocessed and will be retried on the next poll.
 */
async function deliverMessages(
  temporal: Client,
  agent: { agentId: string; agentEmail: string; ownerEmail: string },
  pending: PendingInboundMessage[],
): Promise<string[]> {
  const participantBatches = new Map<string, ParticipantBatch>();
  const ownerMessages: Array<{ workflowId: string; messageId: string }> = [];
  const delivered: string[] = [];

  // Phase 1: resolve each message to a target workflow, then bucket it as
  // either an individual owner signal or a batched participant signal.
  for (const msg of pending) {
    const route = await resolveTargetWorkflow(temporal, agent, msg);
    if (!route) continue;

    if (msg.isOwner) {
      ownerMessages.push({ workflowId: route.workflowId, messageId: msg.messageId });
      continue;
    }

    const existing = participantBatches.get(route.workflowId);
    if (!existing) {
      participantBatches.set(route.workflowId, {
        workflowId: route.workflowId,
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

  // Phase 2: deliver owner signals one-at-a-time.
  for (const owner of ownerMessages) {
    try {
      log.info(`  → Owner signal for ${owner.workflowId} (messageId=${owner.messageId})`);
      await temporal.workflow.getHandle(owner.workflowId).signal(SIGNAL_OWNER, owner.messageId);
      delivered.push(owner.messageId);
    } catch (error) {
      log.error(`  Failed to send owner signal for ${owner.workflowId}:`, error);
    }
  }

  // Phase 3: deliver participant batches as single `on_email` signals.
  for (const batch of participantBatches.values()) {
    try {
      log.info(`  → Participant batch for ${batch.workflowId} (${batch.messageIds.length} message(s))`);
      const inboundEmail: InboundEmail = {
        messageId: batch.messageIds[0],
        sender: batch.senders[0],
        inboxId: agent.agentEmail,
        timestamp: batch.latestTimestamp,
        tag: batch.tag,
        batchMessageIds: batch.messageIds,
        batchSenders: batch.senders,
      };
      await temporal.workflow.getHandle(batch.workflowId).signal(SIGNAL_EMAIL, inboundEmail);
      delivered.push(...batch.messageIds);
    } catch (error) {
      log.error(`  Failed to send participant batch for ${batch.workflowId}:`, error);
    }
  }

  return delivered;
}

/**
 * Decide which workflow should receive a given message. Rules:
 *   - `+tag` that matches a known task → that child task's workflow
 *   - `+tag` with no matching task (orphan) → root workflow
 *   - no tag → root workflow
 * Returns `null` if the chosen workflow isn't running; the gateway will defer
 * the message (leave it unprocessed) and retry on the next poll.
 */
async function resolveTargetWorkflow(
  temporal: Client,
  agent: { agentId: string; agentEmail: string },
  msg: PendingInboundMessage,
): Promise<{ workflowId: string; tag?: string } | null> {
  const rootWorkflowId = `agent__${agent.agentId}__root`;

  if (msg.tag && msg.tag !== "root") {
    const task = await prisma.task.findUnique({ where: { tag: msg.tag } });
    if (task) {
      const workflowId = `task-${task.taskId}`;
      if (!(await isWorkflowRunning(temporal, workflowId))) {
        log.info(`  → Deferring email for stopped task ${task.taskId} (will retry on restart)`);
        return null;
      }
      return { workflowId, tag: msg.tag };
    }
    log.info(`  → Orphan tag "${msg.tag}", routing to root task for agent ${agent.agentId}`);
  }

  if (!(await isWorkflowRunning(temporal, rootWorkflowId))) {
    log.info(`  → Deferring email because root workflow is stopped for agent ${agent.agentId} (will retry on restart)`);
    return null;
  }
  return { workflowId: rootWorkflowId, tag: msg.tag ?? undefined };
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
