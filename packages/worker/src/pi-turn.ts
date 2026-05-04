import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { prisma, buildSystemPrompt, createLogger, getAgentsDir, publishTurnSnapshot } from "@summon/shared";
import type { AgentSignature, DecisionResult, PendingMessage } from "@summon/shared";
import type { AgentMessage } from "../pi-types.js";
import { uuidv7 } from "uuidv7";
import {
  compactTaskContext,
  estimateMessagesTokens,
  loadCodexCredentials,
} from "./compaction.js";
import {
  createSendEmailTool,
  createReplyEmailTool,
  createReadEmailTool,
  createDownloadEmailAttachmentTool,
  createReadEmailsTool,
  createFilteredReadEmailsTool,
  createListThreadsTool,
  createFilteredListThreadsTool,
} from "./tools/agentmail-tools.js";
import { createBashTool } from "./tools/bash-tool.js";
import { createReadFileTool, createWriteFileTool } from "./tools/file-tools.js";
import { createDecideTool } from "./tools/decide-tool.js";
import {
  createSpawnTaskTool,
  createWakeTaskTool,
  createCancelTaskTool,
  createListTasksTool,
  createGetTaskConversationTool,
  createAgentConfigTool,
} from "./tools/task-management-tools.js";
import {
  createCreateScheduleTool,
  createListSchedulesTool,
  createCancelScheduleTool,
} from "./tools/schedule-tools.js";
import {
  ensureSharedSkillsLink,
  loadSkillManifest,
  renderSkillManifest,
} from "./skill-manifest.js";
import fs from "fs";
import path from "path";

const AGENTS_DIR = getAgentsDir();
const log = createLogger("pi-turn");

export async function runPiAgentTurnImpl(
  taskId: string,
  _turnLogId: number,
): Promise<DecisionResult> {
  const taskLog = log.child(`task:${taskId}`);
  taskLog.info("Starting Pi agent turn");

  // 1. Load task and agent from DB
  const task = await prisma.task.findUniqueOrThrow({ where: { taskId } });
  const agent = await prisma.agent.findUniqueOrThrow({ where: { agentId: task.agentId } });
  const isRoot = task.isRoot;

  taskLog.info(`Loaded task for agent ${agent.agentId} (${agent.name}), isRoot=${isRoot}, objective: ${task.objective.slice(0, 100)}`);

  // 2. Load conversation history (scoped to task, filtered past any prior compaction cursor)
  const compactedThroughId = task.compactedThroughId ?? null;
  const conversations = await prisma.conversation.findMany({
    where: {
      taskId,
      ...(compactedThroughId !== null ? { id: { gt: compactedThroughId } } : {}),
    },
    orderBy: { id: "asc" },
  });

  // 3. Deserialize messages
  let messages: AgentMessage[] = conversations.map((c) => JSON.parse(c.message));

  // 4. Ensure agent workspace exists
  const agentDir = path.join(AGENTS_DIR, agent.agentId);
  fs.mkdirSync(agentDir, { recursive: true });

  // Symlink shared/ into the agent workspace so every agent has access to shared skills.
  // Target is relative to the directory containing the symlink: ../../shared resolves from
  // packages/worker/agents/{id}/ up to packages/worker/shared/.
  const sharedLink = ensureSharedSkillsLink(agentDir);
  if (sharedLink.warning) {
    taskLog.warn(sharedLink.warning);
  }

  // Ensure task-level directory exists (child tasks only)
  if (!isRoot) {
    const taskDir = path.join(agentDir, "tasks", task.tag);
    fs.mkdirSync(taskDir, { recursive: true });
  }

  // 5. Build the role prompt with the current skill manifest.
  const skillManifest = loadSkillManifest(agentDir);
  for (const warning of skillManifest.warnings) {
    taskLog.warn(warning);
  }
  const systemPrompt = buildSystemPrompt(isRoot, renderSkillManifest(skillManifest.entries));

  // 6. Set up decision capture
  let capturedDecision: DecisionResult | null = null;

  // Build the email signature block from agent profile fields (null-safe — if the
  // agent pre-dates the feature and has no signature fields, outgoing emails remain
  // unsigned).
  const signature: AgentSignature | null = agent.signatureDisplayName
    ? {
        displayName: agent.signatureDisplayName,
        description: agent.signatureDescription ?? null,
        profileImageUrl: agent.profileImageUrl ?? null,
        companyName: process.env.COMPANY_NAME?.trim() || null,
        companyWebsite: process.env.COMPANY_WEBSITE?.trim() || null,
      }
    : null;

  // 7. Build tools based on root vs child
  const tools = isRoot
    ? [
        // Root: unfiltered email tools, base address
        createSendEmailTool(agent.agentEmail, agentDir, undefined, signature),
        createReplyEmailTool(agent.agentEmail, agentDir, undefined, signature),
        createReadEmailTool(agent.agentEmail, agent.ownerEmail),
        createDownloadEmailAttachmentTool(agent.agentEmail, agent.ownerEmail, agentDir),
        createReadEmailsTool(agent.agentEmail),
        createListThreadsTool(agent.agentEmail),
        // Root: task management tools
        createSpawnTaskTool(agent.agentId, agent.agentEmail),
        createWakeTaskTool(),
        createCancelTaskTool(),
        createListTasksTool(agent.agentId),
        createGetTaskConversationTool(),
        createAgentConfigTool(agent.agentId),
        // Schedule tools
        createCreateScheduleTool(task.taskId, agent.agentId, true),
        createListSchedulesTool(task.taskId, agent.agentId, true),
        createCancelScheduleTool(task.taskId, true),
        // Shared tools
        createBashTool(agentDir),
        createReadFileTool(agentDir),
        createWriteFileTool(agentDir),
        createDecideTool((d) => { capturedDecision = d; }, { isRoot: true }),
      ]
    : [
        // Child: filtered email tools, +tag address
        createSendEmailTool(agent.agentEmail, agentDir, task.tag, signature),
        createReplyEmailTool(agent.agentEmail, agentDir, task.tag, signature),
        createReadEmailTool(agent.agentEmail, agent.ownerEmail),
        createDownloadEmailAttachmentTool(agent.agentEmail, agent.ownerEmail, agentDir),
        createFilteredReadEmailsTool(agent.agentEmail, task.tag),
        createFilteredListThreadsTool(agent.agentEmail, task.tag),
        // Schedule tools
        createCreateScheduleTool(task.taskId, agent.agentId, false),
        createListSchedulesTool(task.taskId, agent.agentId, false),
        createCancelScheduleTool(task.taskId, false),
        // Shared tools
        createBashTool(agentDir),
        createReadFileTool(agentDir),
        createWriteFileTool(agentDir),
        createDecideTool((d) => { capturedDecision = d; }, {
          todoFilePath: path.join(agentDir, "tasks", task.tag, "todo.md"),
        }),
      ];

  taskLog.info(`System prompt built: ${systemPrompt.length} chars, ${messages.length} messages, ${tools.length} tools`);

  // 8. Get model (GPT-5.5 via ChatGPT OAuth subscription)
  const model = getModel("openai-codex", "gpt-5.5");

  // 8a. Load OAuth credentials (auto-refreshes if expired)
  const codexCreds = await loadCodexCredentials();

  // 8b. Compact context if active messages exceed threshold. We split the
  // active history at a "keep recent" boundary: everything before the split
  // gets compacted, everything after stays active. This guarantees the agent
  // always has at least the latest wake message to continue from.
  const COMPACT_THRESHOLD_TOKENS = 100_000;
  const KEEP_RECENT_TOKENS = 20_000;
  const estTokens = estimateMessagesTokens(messages);
  taskLog.info(`Active context: ${messages.length} messages, ~${estTokens} tokens`);

  if (estTokens > COMPACT_THRESHOLD_TOKENS && conversations.length > 0) {
    // Walk backward, accumulating tokens until we hit KEEP_RECENT_TOKENS.
    // Everything at `splitIdx` and later is kept active. The split MUST land
    // on a user-role message (turn boundary) so we don't orphan tool results
    // from their tool calls.
    let acc = 0;
    let splitIdx = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      acc += estimateMessagesTokens([messages[i]]);
      const role = (messages[i] as { role?: string }).role;
      if (acc >= KEEP_RECENT_TOKENS && role === "user") {
        splitIdx = i;
        break;
      }
    }
    // Fallback: if no valid user-role cut point found, scan backward from the
    // end for the most recent user message (ensures we always keep at least
    // the latest wake trigger).
    if (splitIdx >= messages.length) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if ((messages[i] as { role?: string }).role === "user") {
          splitIdx = i;
          break;
        }
      }
    }
    if (splitIdx <= 0) {
      taskLog.info(`Single large turn exceeds threshold — cannot split safely, skipping compaction`);
    } else {
      const olderMessages = messages.slice(0, splitIdx);
      const recentMessages = messages.slice(splitIdx);
      const olderTokens = estimateMessagesTokens(olderMessages);
      const cutoffConvId = conversations[splitIdx - 1].id; // last conv id being compacted
      taskLog.info(
        `Context exceeds ${COMPACT_THRESHOLD_TOKENS} tokens, compacting ${olderMessages.length} older messages (~${olderTokens} tokens), keeping ${recentMessages.length} recent`,
      );
      const result = await compactTaskContext({
        taskId,
        activeMessages: olderMessages,
        credentials: codexCreds,
        existingCompactedSummary: task.compactedSummary,
        lastConversationId: cutoffConvId,
        tokensBefore: olderTokens,
      });
      if (result.mode === "summary") {
        // Keep only the recent messages in the active array; older ones are
        // now represented by the compacted prefix/summary and will be
        // injected via onPayload.
        messages = recentMessages;
      }
      // Reload task for onPayload closure below
      const refreshed = await prisma.task.findUniqueOrThrow({ where: { taskId } });
      task.compactedPrefix = refreshed.compactedPrefix;
      task.compactedSummary = refreshed.compactedSummary;
      task.compactedThroughId = refreshed.compactedThroughId;
    }
  }

  // 9. Create Agent instance
  const initialMessageCount = messages.length;
  const piAgent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: "off",
      tools,
      messages,
    },
    getApiKey: () => codexCreds.access,
    onPayload: async (params) => {
      const p = params as { input?: unknown[]; [k: string]: unknown };
      if (!Array.isArray(p.input)) return undefined;
      // Inject per-request headers for codex backend (account id is required)
      if (Array.isArray(task.compactedPrefix)) {
        return { ...p, input: [...(task.compactedPrefix as unknown[]), ...p.input] };
      }
      if (task.compactedSummary) {
        const summaryItem = {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `## Prior conversation summary\n\n${task.compactedSummary}`,
            },
          ],
        };
        return { ...p, input: [summaryItem, ...p.input] };
      }
      return undefined;
    },
  });

  // 10. Subscribe to events: log tool execution + maintain a pending-messages
  //     buffer that gets published to SSE subscribers via pg_notify while the
  //     turn is in flight. Pi emits cloned assistant messages while streaming,
  //     so keep stable slots independent from event object identity.
  type PendingSlot = { orderingKey: string; message: AgentMessage };
  const pendingOrder: PendingSlot[] = [];
  const committedOrderingKeys = new WeakMap<AgentMessage, string>();
  let activeAssistantSlot: PendingSlot | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPublishMs = 0;
  const PUBLISH_THROTTLE_MS = 50;

  function buildSnapshot(): PendingMessage[] {
    return pendingOrder.map((slot) => ({
      orderingKey: slot.orderingKey,
      role: slot.message.role,
      message: slot.message,
    }));
  }

  function flushPublish(): void {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    lastPublishMs = Date.now();
    const snapshot = buildSnapshot();
    // Fire-and-forget: NOTIFY round-trips must not block Pi's event loop, which
    // fires deltas at 30–60 Hz during token streaming.
    publishTurnSnapshot(taskId, snapshot).catch((err) => {
      taskLog.warn(`publishTurnSnapshot failed: ${String(err)}`);
    });
  }

  function schedulePublish(immediate: boolean): void {
    if (immediate) {
      flushPublish();
      return;
    }
    if (throttleTimer) return;
    const elapsed = Date.now() - lastPublishMs;
    const wait = Math.max(0, PUBLISH_THROTTLE_MS - elapsed);
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      flushPublish();
    }, wait);
  }

  piAgent.subscribe((event) => {
    switch (event.type) {
      case "message_start": {
        const slot = { orderingKey: uuidv7(), message: event.message };
        pendingOrder.push(slot);
        if (event.message.role === "assistant") {
          activeAssistantSlot = slot;
        }
        schedulePublish(true);
        break;
      }
      case "message_update":
        if (activeAssistantSlot) {
          activeAssistantSlot.message = event.message;
        }
        schedulePublish(false);
        break;
      case "message_end":
        if (activeAssistantSlot && event.message.role === "assistant") {
          activeAssistantSlot.message = event.message;
          committedOrderingKeys.set(event.message, activeAssistantSlot.orderingKey);
          activeAssistantSlot = null;
        } else {
          const slot = pendingOrder[pendingOrder.length - 1];
          if (slot) {
            slot.message = event.message;
            committedOrderingKeys.set(event.message, slot.orderingKey);
          }
        }
        schedulePublish(true);
        break;
      case "tool_execution_start":
        taskLog.info(`Tool call started: ${event.toolName}`);
        break;
      case "tool_execution_end":
        taskLog.info(`Tool call ended: ${event.toolName} (error: ${event.isError})`);
        break;
    }
  });

  // 11. Run the turn
  taskLog.info("Executing Pi agent continue()...");
  try {
    await piAgent.continue();
    await waitForIdle(piAgent);
    taskLog.info("Pi agent turn execution completed");
  } catch (error) {
    taskLog.error("Pi agent turn execution failed", error);
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    try {
      await publishTurnSnapshot(taskId, []);
    } catch (notifyErr) {
      taskLog.warn(`Failed to clear overlay after turn error: ${String(notifyErr)}`);
    }
    return {
      type: "fail",
      stopReason: `Agent turn failed: ${error instanceof Error ? error.message : String(error)}`,
      error: String(error),
    };
  }

  // 12. Persist new messages to DB — single createMany so the ordering_key
  //     watermark jumps past the entire turn atomically from a reader's view.
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  const newMessages = piAgent.state.messages.slice(initialMessageCount);
  taskLog.info(`Persisting ${newMessages.length} new messages to DB`);
  if (newMessages.length > 0) {
    await prisma.conversation.createMany({
      data: newMessages.map((msg) => ({
        taskId,
        role: msg.role,
        message: JSON.stringify(msg),
        // Use the buffered ordering key when available. Defensive fallback: if
        // a message somehow appeared in state.messages without a corresponding
        // message_start event (shouldn't happen), mint one now.
        orderingKey: committedOrderingKeys.get(msg) ?? uuidv7(),
      })),
    });
  }
  pendingOrder.length = 0;
  activeAssistantSlot = null;
  try {
    await publishTurnSnapshot(taskId, []);
  } catch (err) {
    taskLog.warn(`Final empty publishTurnSnapshot failed: ${String(err)}`);
  }

  // 13. Update lastActivityAt
  await prisma.task.update({
    where: { taskId },
    data: { lastActivityAt: new Date() },
  });

  // 14. Return decision
  const finalDecision = capturedDecision ?? {
    type: "sleep" as const,
    stopReason: "No explicit decision was made. Defaulting to sleep.",
    sleepDurationMs: 24 * 60 * 60 * 1000,
  };
  taskLog.info(`Turn decision: ${finalDecision.type}`, { decision: finalDecision });
  return finalDecision;
}

async function waitForIdle(agent: Agent): Promise<void> {
  while (agent.state.isStreaming) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
