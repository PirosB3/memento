import { Agent } from "../../../repos/pi-mono/packages/agent/dist/index.js";
import { getModel } from "../../../repos/pi-mono/packages/ai/dist/index.js";
import {
  convertResponsesMessages,
  convertResponsesTools,
} from "../../../repos/pi-mono/packages/ai/dist/providers/openai-responses-shared.js";
import { prisma, buildSystemPrompt, createLogger, getAgentsDir } from "@summon/shared";
import type { AgentSignature, DecisionResult } from "@summon/shared";
import type { AgentMessage } from "../pi-types.js";
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
  emailAddressEquals,
  subjectHasActionRequiredMarker,
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
  const sharedLinkPath = path.join(agentDir, "shared");
  if (!fs.existsSync(sharedLinkPath)) {
    try {
      fs.symlinkSync("../../shared", sharedLinkPath, "dir");
    } catch (err) {
      taskLog.warn(`Failed to create shared/ symlink: ${String(err)}`);
    }
  }

  // Ensure task-level directory exists (child tasks only)
  if (!isRoot) {
    const taskDir = path.join(agentDir, "tasks", task.tag);
    fs.mkdirSync(taskDir, { recursive: true });
  }

  // 5. Build the static role prompt
  const systemPrompt = buildSystemPrompt(isRoot);

  // 6. Set up decision capture
  let capturedDecision: DecisionResult | null = null;
  let sentMarkedEscalationEmail = false;
  const trackSentEmail = (email: { to: string[]; subject: string }) => {
    const sentToOwner = email.to.some((recipient) => emailAddressEquals(recipient, agent.ownerEmail));
    if (sentToOwner && subjectHasActionRequiredMarker(email.subject)) {
      sentMarkedEscalationEmail = true;
    }
  };
  const hasSentEscalationEmail = () => sentMarkedEscalationEmail;

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
        createSendEmailTool(agent.agentEmail, agentDir, undefined, { signature, onSentEmail: trackSentEmail }),
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
        createDecideTool((d) => { capturedDecision = d; }, { isRoot: true, hasSentEscalationEmail }),
      ]
    : [
        // Child: filtered email tools, +tag address
        createSendEmailTool(agent.agentEmail, agentDir, task.tag, { signature, onSentEmail: trackSentEmail }),
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
          hasSentEscalationEmail,
        }),
      ];

  taskLog.info(`System prompt built: ${systemPrompt.length} chars, ${messages.length} messages, ${tools.length} tools`);

  // 8. Get model (GPT-5.4 via ChatGPT OAuth subscription)
  const model = getModel("openai-codex", "gpt-5.4");

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
        systemPrompt,
        tools,
        mainModelId: "gpt-5.4",
        credentials: codexCreds,
        existingCompactedPrefix: task.compactedPrefix,
        existingCompactedSummary: task.compactedSummary,
        lastConversationId: cutoffConvId,
        tokensBefore: olderTokens,
        convertResponsesMessages: convertResponsesMessages as never,
        responsesToolConverter: convertResponsesTools as never,
        codexModelForConvert: model as never,
      });
      if (result.mode === "prefix" || result.mode === "summary") {
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

  // 10. Subscribe to events for logging
  piAgent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      taskLog.info(`Tool call started: ${event.toolName}`);
    }
    if (event.type === "tool_execution_end") {
      taskLog.info(`Tool call ended: ${event.toolName} (error: ${event.isError})`);
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
    return {
      type: "fail",
      stopReason: `Agent turn failed: ${error instanceof Error ? error.message : String(error)}`,
      error: String(error),
    };
  }

  // 12. Persist new messages to DB
  const newMessages = piAgent.state.messages.slice(initialMessageCount);
  taskLog.info(`Persisting ${newMessages.length} new messages to DB`);
  for (const msg of newMessages) {
    await prisma.conversation.create({
      data: { taskId, role: msg.role, message: JSON.stringify(msg) },
    });
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
