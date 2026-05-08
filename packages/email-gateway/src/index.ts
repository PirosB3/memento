import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { Client, Connection } from "@temporalio/client";
import { AgentMailClient } from "agentmail";
import {
  prisma,
  SIGNAL_EMAIL,
  SIGNAL_OWNER,
  createLogger,
  getTemporalAddress,
  findTaskByAgentmailThreadId,
  recordTaskThreadId,
  AgentMailThreadBindingConflictError,
} from "@summon/shared";
import type { InboundEmail } from "@summon/shared";

const POLL_INTERVAL_MS = 15_000;
const log = createLogger("email-gateway");

/**
 * A parsed inbound message ready for routing. `isOwner` and the AgentMail
 * threadId are resolved once here so the routing step doesn't need to re-parse.
 */
interface PendingInboundMessage {
  messageId: string;
  timestamp: string;
  senderEmail: string;
  isOwner: boolean;
  agentmailThreadId: string | null;
  legacyTag: string | null;
}

/**
 * Accumulated batch of participant emails headed for the same workflow.
 * Owner emails are NOT batched — see `deliverMessages` for why.
 */
interface ParticipantBatch {
  workflowId: string;
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
      const rootWorkflowRunning = await isWorkflowRunning(temporal, `agent__${agent.agentId}__root`);
      if (!rootWorkflowRunning) {
        log.info(`  [${agent.agentId}] Skipping inbox poll because root workflow is stopped`);
        continue;
      }
      await pollInbox(agentmail, temporal, agent);
    } catch (err) {
      log.error(`Error polling inbox for agent ${agent.agentId}:`, err);
    }
  }
}

export function isSelfSentEmail(fromField: string, agentEmail: string): boolean {
  return fromField
    .toLowerCase()
    .includes(agentEmail.split("@")[0].toLowerCase() + "@");
}

/**
 * AgentMail returns addresses as either bare ("a@b.com") or display-name form
 * ("Name <a@b.com>"). Extract the bare address, lowercase it, and strip any
 * surrounding whitespace. Returns "" for empty/undefined input.
 */
export function extractBareAddress(raw: string | undefined | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/<([^>]+)>/);
  return (match?.[1] ?? trimmed).trim().toLowerCase();
}

/**
 * For a message the agent itself sent (labels include "sent" OR from matches
 * self), extract every `to`/`cc` recipient that isn't the agent itself and
 * isn't a `+tag` routing address, and add the normalized form to `out`.
 *
 * These recipients are the "emails I replied to" set — the only addresses the
 * spam post-filter considers trustworthy.
 */
export function collectOutboundRecipients(
  msg: Record<string, unknown>,
  agentEmail: string,
  out: Set<string>,
): void {
  const labels = (msg.labels as string[] | undefined) ?? [];
  const from = (msg.from as string) ?? "";
  const isOutbound = labels.includes("sent") || isSelfSentEmail(from, agentEmail);
  if (!isOutbound) return;

  const agentEmailLc = agentEmail.toLowerCase();
  const [local, domain] = agentEmailLc.split("@");
  const taggedPrefix = `${local}+`;
  const taggedSuffix = `@${domain}`;

  const to = coerceAddressList(msg.to);
  const cc = coerceAddressList(msg.cc);

  for (const raw of [...to, ...cc]) {
    const email = extractBareAddress(raw);
    if (!email) continue;
    if (email === agentEmailLc) continue;
    if (email.startsWith(taggedPrefix) && email.endsWith(taggedSuffix)) continue;
    out.add(email);
  }
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
    includeSpam: true,
  }) as unknown as Record<string, unknown>;

  const messages = (response.messages ?? response.data ?? response) as Record<string, unknown>[];
  if (!Array.isArray(messages) || messages.length === 0) return;

  // Upsert contacts BEFORE running the spam filter in collectPendingMessages, so
  // any outbound recipients in this same poll cycle are considered "known"
  // when evaluating spam-labeled replies that showed up alongside them.
  const outboundRecipients = new Set<string>();
  for (const msg of messages) {
    collectOutboundRecipients(msg, agent.agentEmail, outboundRecipients);
  }
  if (outboundRecipients.size > 0) {
    await prisma.emailContact.createMany({
      data: [...outboundRecipients].map((emailAddress) => ({
        inboxId: agent.agentEmail,
        emailAddress,
      })),
      skipDuplicates: true,
    });
  }

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
  agent: { agentId: string; agentEmail: string; ownerEmail: string },
): Promise<PendingInboundMessage[]> {
  const pending: PendingInboundMessage[] = [];

  for (const msg of messages) {
    const labels = (msg.labels as string[] | undefined) ?? [];
    if (!labels.includes("received")) continue;

    const messageId = (msg.messageId as string) ?? (msg.message_id as string);
    if (!messageId) continue;

    const from = (msg.from as string) ?? "";
    if (isSelfSentEmail(from.toLowerCase(), agent.agentEmail)) continue;

    const existing = await prisma.processedEmail.findUnique({ where: { messageId } });
    if (existing) continue;

    const timestamp = (msg.timestamp as string)
      ?? (msg.created_at as string)
      ?? new Date().toISOString();

    const senderEmail = extractBareAddress(from);

    // Spam post-filter: AgentMail list now returns spam-labeled messages
    // (includeSpam: true in pollInbox). Only deliver spam from senders we've
    // previously sent mail to — the "emails I replied to" set. Cold-outreach
    // spam from addresses we've never engaged with is dropped.
    if (labels.includes("spam")) {
      const senderKnown = await isKnownContact(agent.agentEmail, senderEmail);
      if (!senderKnown) {
        log.info(`  [${agent.agentId}] Dropping spam-labeled message from unknown sender ${senderEmail} (messageId=${messageId})`);
        continue;
      }
      log.info(`  [${agent.agentId}] Accepting spam-labeled message from known contact ${senderEmail} (messageId=${messageId})`);
    }

    pending.push({
      messageId,
      timestamp,
      senderEmail,
      isOwner: senderEmail === agent.ownerEmail.toLowerCase(),
      agentmailThreadId: extractAgentmailThreadId(msg),
      legacyTag: extractLegacyTagFromRecipients(msg, agent.agentEmail),
    });
  }

  return pending;
}

function coerceAddressList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return [raw];
  return [];
}

function extractAgentmailThreadId(msg: Record<string, unknown>): string | null {
  const threadId = msg.threadId ?? msg.thread_id;
  return typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
}

export function extractLegacyTagFromRecipients(
  msg: Record<string, unknown>,
  agentEmail: string,
): string | null {
  const atIndex = agentEmail.lastIndexOf("@");
  if (atIndex < 1) return null;

  const baseLocal = agentEmail.slice(0, atIndex).toLowerCase();
  const domain = agentEmail.slice(atIndex + 1).toLowerCase();
  const legacyPrefix = `${baseLocal}+`;
  const candidates = [
    ...coerceAddressList(msg.to),
    ...coerceAddressList(msg.cc),
  ];

  for (const candidate of candidates) {
    const address = extractBareAddress(candidate);
    const candidateAtIndex = address.lastIndexOf("@");
    if (candidateAtIndex < 1) continue;

    const local = address.slice(0, candidateAtIndex);
    const candidateDomain = address.slice(candidateAtIndex + 1);
    if (candidateDomain !== domain || !local.startsWith(legacyPrefix)) continue;

    const tag = local.slice(legacyPrefix.length);
    if (tag) return tag;
  }

  return null;
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

async function resolveLegacyTaggedWorkflow(
  temporal: Client,
  agent: { agentId: string },
  legacyTag: string | null,
  agentmailThreadId: string,
): Promise<{ workflowId: string } | null> {
  if (!legacyTag) return null;

  const task = await prisma.task.findFirst({
    where: { agentId: agent.agentId, tag: legacyTag, isRoot: false },
    select: { taskId: true },
  });
  if (!task) {
    log.info(`  → Legacy +tag "${legacyTag}" did not match a child task for agent ${agent.agentId}`);
    return null;
  }

  try {
    await recordTaskThreadId(prisma, {
      taskId: task.taskId,
      agentmailThreadId,
    });
  } catch (err) {
    if (err instanceof AgentMailThreadBindingConflictError) {
      log.warn(
        `  → Legacy +tag fallback conflict for AgentMail thread "${agentmailThreadId}": already bound to task ${err.existingTaskId}`,
      );
      return null;
    }
    throw err;
  }

  const workflowId = `task-${task.taskId}`;
  const workflowRunning = await isWorkflowRunning(temporal, workflowId);
  if (!workflowRunning) {
    log.info(`  → Deferring legacy-tag email for stopped task ${task.taskId} (will retry on restart)`);
    return null;
  }

  log.info(`  → Routed legacy +tag "${legacyTag}" by creating AgentMail thread binding for task ${task.taskId}`);
  return { workflowId };
}

/**
 * Decide which workflow should receive a given message. Rules:
 *   - inbound AgentMail threadId matches an `agentmail_thread_bindings` row →
 *     that task's workflow
 *   - temporary cutover fallback: unmatched legacy `+tag` recipients lazily
 *     create a bridge binding and route to that child
 *   - no match → root workflow
 * Returns `null` if the chosen workflow isn't running; the gateway will defer
 * the message (leave it unprocessed) and retry on the next poll.
 */
export async function resolveTargetWorkflow(
  temporal: Client,
  agent: { agentId: string; agentEmail: string },
  msg: PendingInboundMessage,
): Promise<{ workflowId: string } | null> {
  const rootWorkflowId = `agent__${agent.agentId}__root`;
  const threadId = msg.agentmailThreadId;

  if (threadId) {
    const match = await findTaskByAgentmailThreadId(prisma, {
      agentId: agent.agentId,
      agentmailThreadId: threadId,
    });
    if (match) {
      const workflowId = `task-${match.taskId}`;
      const workflowRunning = await isWorkflowRunning(temporal, workflowId);
      if (!workflowRunning) {
        log.info(`  → Deferring email for stopped task ${match.taskId} (will retry on restart)`);
        return null;
      }
      return { workflowId };
    }

    const legacyRoute = await resolveLegacyTaggedWorkflow(temporal, agent, msg.legacyTag, threadId);
    if (legacyRoute) return legacyRoute;

    log.info(`  → No task bound to AgentMail thread "${threadId}", routing to root for agent ${agent.agentId}`);
  }

  const rootWorkflowRunning = await isWorkflowRunning(temporal, rootWorkflowId);
  if (!rootWorkflowRunning) {
    log.info(`  → Deferring email because root workflow is stopped for agent ${agent.agentId} (will retry on restart)`);
    return null;
  }
  return { workflowId: rootWorkflowId };
}

/**
 * Known contacts are addresses this inbox has previously sent an email to.
 * Populated by `pollInbox` (live) and `backfill-contacts` (one-shot) from the
 * to/cc of sent-labeled messages. Used by the spam post-filter in
 * `collectPendingMessages` to rescue misclassified replies from people we're
 * already in conversation with while still dropping cold spam.
 */
export async function isKnownContact(
  inboxId: string,
  emailAddress: string,
): Promise<boolean> {
  const normalized = emailAddress.trim().toLowerCase();
  if (!normalized) return false;
  const match = await prisma.emailContact.findFirst({
    where: { inboxId, emailAddress: normalized },
    select: { id: true },
  });
  return match !== null;
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
