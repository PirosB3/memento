import { Type } from "@sinclair/typebox";
import {
  prisma,
  createLogger,
  getTemporalAddress,
  publishTurnSnapshot,
  recordTaskThreadId,
  AgentMailThreadBindingConflictError,
  findTaskBySlug,
  SIGNAL_EMAIL,
  SIGNAL_OWNER,
} from "@summon/shared";
import { uuidv7 } from "uuidv7";
import { Client, Connection } from "@temporalio/client";
import { AgentMailClient } from "agentmail";
import type { AgentTool } from "../../pi-types.js";

const log = createLogger("route-email-to-thread");

let temporalClient: Client | null = null;
async function getTemporalClient(): Promise<Client> {
  if (!temporalClient) {
    const connection = await Connection.connect({ address: getTemporalAddress() });
    temporalClient = new Client({ connection });
  }
  return temporalClient;
}

let agentmailClient: { inboxes: { messages: { get: (inboxId: string, messageId: string) => Promise<unknown> } } } | null = null;
function getAgentmailClient() {
  if (!agentmailClient) {
    agentmailClient = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! }) as unknown as typeof agentmailClient;
  }
  return agentmailClient!;
}

export function setAgentMailClientForTests(client: typeof agentmailClient): void {
  agentmailClient = client;
}

function normalizeAddress(raw: string | undefined | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/<([^>]+)>/);
  return (match?.[1] ?? trimmed).trim().toLowerCase();
}

/**
 * `route_email_to_thread` (root-only) attaches an unmatched inbound email's
 * AgentMail thread to an existing child task. After this:
 *   - the gateway will route future replies in this AgentMail thread to the
 *     child task (via the agentmail_thread_bindings bridge table)
 *   - the child task is signalled so it processes this specific message in
 *     its next turn
 *
 * Use case: root wakes from an unmatched inbound email, scans existing tasks
 * for a plausible match, and forwards the email to that task instead of
 * spawning a duplicate.
 */
export function createRouteEmailToThreadTool(
  agentId: string,
  agentEmail: string,
  ownerEmail: string,
): AgentTool {
  return {
    name: "route_email_to_thread",
    label: "Route Email to Thread",
    description:
      "Attach an unmatched inbound email's AgentMail thread to an existing child task. The task is woken with the message so it can process it. Use this in INBOUND EMAIL TRIAGE before resorting to spawn_task.",
    parameters: Type.Object({
      thread_slug: Type.String({ description: "The child task's slug (see list_tasks output)." }),
      message_id: Type.String({ description: "AgentMail message ID of the email being routed." }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const { thread_slug, message_id } = params as { thread_slug: string; message_id: string };

        const task = await findTaskBySlug(prisma, { agentId, slug: thread_slug });
        if (!task) {
          return {
            content: [{ type: "text" as const, text: `No child task found with slug "${thread_slug}".` }],
            details: { error: true, reason: "SLUG_NOT_FOUND" },
          };
        }

        const agentmail = getAgentmailClient();
        let msg: Record<string, unknown>;
        try {
          msg = await agentmail.inboxes.messages.get(agentEmail, message_id) as Record<string, unknown>;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Could not fetch message ${message_id}: ${reason}` }],
            details: { error: true },
          };
        }

        const threadId = (msg.threadId ?? msg.thread_id) as string | undefined;
        if (!threadId) {
          return {
            content: [{ type: "text" as const, text: `Message ${message_id} has no threadId — cannot route.` }],
            details: { error: true },
          };
        }

        try {
          await recordTaskThreadId(prisma, { agentId, taskId: task.taskId, agentmailThreadId: threadId });
        } catch (err) {
          if (err instanceof AgentMailThreadBindingConflictError) {
            return {
              content: [{
                type: "text" as const,
                text: `AgentMail thread ${threadId} is already routed to task ${err.existingTaskId}; not routing it to ${task.taskId}.`,
              }],
              details: {
                error: true,
                reason: "THREAD_ALREADY_BOUND",
                threadId,
                existingTaskId: err.existingTaskId,
                requestedTaskId: task.taskId,
              },
            };
          }
          throw err;
        }

        const senderEmail = normalizeAddress(msg.from as string | undefined);
        const isOwner = senderEmail === ownerEmail.toLowerCase();
        const signalName = isOwner ? SIGNAL_OWNER : SIGNAL_EMAIL;

        // Insert a conversation row so the next turn picks the message up
        // even if the signal races. Mirrors createWakeTaskTool's pattern.
        await prisma.conversation.create({
          data: {
            taskId: task.taskId,
            role: "user",
            message: JSON.stringify({
              role: "user",
              content: `## INLINE ROOT TASK MESSAGE
Source: root routed inbound email
Slug: ${thread_slug}
AgentMail thread: ${threadId}
Message ID: ${message_id}
Sender: ${senderEmail || "unknown"}`,
              timestamp: Date.now(),
            }),
            orderingKey: uuidv7(),
          },
        });
        await publishTurnSnapshot(task.taskId, []).catch((err) => {
          log.warn(`publishTurnSnapshot after route_email_to_thread failed: ${String(err)}`);
        });

        const temporal = await getTemporalClient();
        const handle = temporal.workflow.getHandle(`task-${task.taskId}`);
        if (signalName === SIGNAL_OWNER) {
          await handle.signal(SIGNAL_OWNER, message_id);
        } else {
          await handle.signal(SIGNAL_EMAIL, {
            messageId: message_id,
            sender: senderEmail,
            inboxId: agentEmail,
            timestamp: new Date().toISOString(),
          });
        }

        log.info(`Routed message ${message_id} thread=${threadId} → task=${task.taskId} slug=${thread_slug} signal=${signalName}`);

        return {
          content: [{
            type: "text" as const,
            text: `Routed ${message_id} (thread ${threadId}) to task ${task.taskId} (slug ${thread_slug}). Signal: ${signalName}.`,
          }],
          details: { taskId: task.taskId, slug: thread_slug, threadId, signalSent: signalName },
        };
      } catch (error) {
        log.error("Failed to route email to thread", error);
        return {
          content: [{ type: "text" as const, text: `Failed to route email: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}
