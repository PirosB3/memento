import {
  prisma,
  createLogger,
  TASK_QUEUE,
  SIGNAL_SCHEDULE,
  getTemporalAddress,
  getAgentsDir,
  publishTurnSnapshot,
} from "@summon/shared";
import { uuidv7 } from "uuidv7";
import type { DecisionResult, AgentStatus, TaskStatus, TaskInfo } from "@summon/shared";
import type { InboundEmail } from "@summon/shared";
import { runPiAgentTurnImpl } from "./pi-turn.js";
import { runReflectionImpl, runChildReflectionStepImpl } from "./reflection.js";
import { runEmailScreener } from "./email-screener.js";
import {
  buildFailClosedScreening,
  type EmailForScreening,
  type ScreenedEmailDecision,
  type ScreenInboundEmailBatchResult,
} from "./email-screener-validation.js";
import { Client, Connection } from "@temporalio/client";
import { AgentMailClient } from "agentmail";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { buildContextSeedMessage, buildWakeMessage } from "./prompt-context.js";
import type { WakeSource } from "@summon/shared";
import {
  buildCappedTodoSnapshot,
  buildInvalidTodoNotice,
  buildMissingTodoNotice,
  readTodoSnapshot,
} from "./todo.js";

let temporalClient: Client | null = null;
async function getTemporalClient(): Promise<Client> {
  if (!temporalClient) {
    const connection = await Connection.connect({ address: getTemporalAddress() });
    temporalClient = new Client({ connection });
  }
  return temporalClient;
}

const log = createLogger("activities");
const EMAIL_SCREENING_TIMEOUT_MS = 120_000;
const AGENTS_DIR = getAgentsDir();
const CONFIG_SNAPSHOT_FILE = ".config_snapshot.json";

export interface Activities {
  loadAgentFromDb: typeof loadAgentFromDb;
  updateAgentStatus: typeof updateAgentStatus;
  loadTaskFromDb: typeof loadTaskFromDb;
  updateTaskStatus: typeof updateTaskStatus;
  createTaskFromEmail: typeof createTaskFromEmail;
  checkTaskExpired: typeof checkTaskExpired;
  getActiveTasks: typeof getActiveTasks;
  insertConversationMessage: typeof insertConversationMessage;
  insertTurnLog: typeof insertTurnLog;
  updateTurnLogReflection: typeof updateTurnLogReflection;
  updateTurnLogStopReason: typeof updateTurnLogStopReason;
  preparePromptMessages: typeof preparePromptMessages;
  screenInboundEmailBatch: typeof screenInboundEmailBatch;
  runReflection: typeof runReflection;
  runPiAgentTurn: typeof runPiAgentTurn;
  runActivityGate: typeof runActivityGate;
  runChildReflectionStep: typeof runChildReflectionStep;
}

export interface PreparePromptMessagesInput {
  includeContextSeed: boolean;
  wake: {
    wokenBy: WakeSource;
    priorState: string;
    lastStopReason?: string | null;
    triggerContext: string;
    metadata?: Array<{ label: string; value: string }>;
    reflection: string;
    actionNow: string;
  };
}

function buildTodoSnapshotForPrompt(agentDir: string, task: { isRoot: boolean; tag: string }): string | undefined {
  if (task.isRoot) return undefined;

  const todoRelativePath = path.join("tasks", task.tag, "todo.md");
  const todoState = readTodoSnapshot(path.join(agentDir, todoRelativePath));

  if (todoState.snapshot === null) {
    return buildMissingTodoNotice(todoRelativePath);
  }

  if (!todoState.isValid) {
    return `${todoState.snapshot}\n\nNOTE: ${buildInvalidTodoNotice(todoRelativePath)}`;
  }

  return buildCappedTodoSnapshot(todoState);
}

function readTextFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function ensureAgentDir(agentId: string): string {
  const agentDir = path.join(AGENTS_DIR, agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

function getConfigSnapshot(agent: { soul: string; boundaries: string; tools: string }) {
  return {
    soul: agent.soul,
    boundaries: agent.boundaries,
    tools: agent.tools,
  };
}

function detectConfigChange(
  agentDir: string,
  agent: { soul: string; boundaries: string; tools: string },
): {
  changed: boolean;
  changedFields: string[];
  snapshot: { soul: string; boundaries: string; tools: string };
} {
  const snapshot = getConfigSnapshot(agent);
  const hash = crypto
    .createHash("md5")
    .update(snapshot.soul + snapshot.boundaries + snapshot.tools)
    .digest("hex");
  const hashFile = path.join(agentDir, ".config_hash");
  const snapshotFile = path.join(agentDir, CONFIG_SNAPSHOT_FILE);

  const previousHash = readTextFileOrNull(hashFile)?.trim() ?? null;
  const previousSnapshotRaw = readTextFileOrNull(snapshotFile);
  let previousSnapshot: Partial<typeof snapshot> = {};

  if (previousSnapshotRaw) {
    try {
      previousSnapshot = JSON.parse(previousSnapshotRaw) as Partial<typeof snapshot>;
    } catch {
      previousSnapshot = {};
    }
  }

  const changedFields = previousHash === null
    ? []
    : (["soul", "boundaries", "tools"] as const).filter(
        (field) => previousSnapshot[field] !== snapshot[field],
      );

  fs.writeFileSync(hashFile, hash + "\n");
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2) + "\n");

  return {
    changed: previousHash !== null && previousHash !== hash,
    changedFields,
    snapshot,
  };
}

// --- Agent-level activities ---

export async function loadAgentFromDb(agentId: string) {
  log.info(`Loading agent from DB: ${agentId}`);
  const agent = await prisma.agent.findUniqueOrThrow({ where: { agentId } });
  log.info(`Agent loaded: ${agentId} status=${agent.status}`);
  return agent;
}

export async function updateAgentStatus(agentId: string, status: AgentStatus) {
  log.info(`Updating agent status: ${agentId} → ${status}`);
  await prisma.agent.update({ where: { agentId }, data: { status } });
}

// --- Task-level activities ---

export async function loadTaskFromDb(taskId: string) {
  log.info(`Loading task from DB: ${taskId}`);
  const task = await prisma.task.findUniqueOrThrow({ where: { taskId } });
  log.info(`Task loaded: ${taskId} status=${task.status} agent=${task.agentId}`);
  return task;
}

export async function updateTaskStatus(taskId: string, status: TaskStatus) {
  log.info(`Updating task status: ${taskId} → ${status}`);
  const data: Record<string, unknown> = {
    status,
    lastActivityAt: new Date(),
  };
  if (status === "COMPLETED") {
    data.completedAt = new Date();
  }
  await prisma.task.update({ where: { taskId }, data });
}

export async function createTaskFromEmail(
  agentId: string,
  objective: string,
  parentTaskId?: string,
): Promise<{ taskId: string; tag: string }> {
  const taskId = crypto.randomUUID();
  const tag = taskId;
  log.info(`Creating task from email: ${taskId} agent=${agentId} parent=${parentTaskId ?? "none"}`, { objective });
  await prisma.task.create({
    data: {
      taskId,
      agentId,
      tag,
      objective,
      status: "RUNNING",
      parentTaskId: parentTaskId ?? null,
    },
  });
  log.info(`Task created: ${taskId}`);
  return { taskId, tag };
}

export async function checkTaskExpired(
  taskId: string,
  maxDaysIdle: number,
): Promise<boolean> {
  const task = await prisma.task.findUniqueOrThrow({ where: { taskId } });
  const now = new Date();
  const elapsed = now.getTime() - task.lastActivityAt.getTime();
  const maxMs = maxDaysIdle * 24 * 60 * 60 * 1000;
  const expired = elapsed > maxMs;
  log.info(`Task expiry check: ${taskId} elapsed=${Math.round(elapsed / 86400000)}d max=${maxDaysIdle}d expired=${expired}`);
  return expired;
}

export async function getActiveTasks(agentId: string): Promise<TaskInfo[]> {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { agentId } });
  const tasks = await prisma.task.findMany({
    where: { agentId, status: { not: "COMPLETED" } },
    orderBy: { createdAt: "desc" },
  });
  const [localPart, domain] = agent.agentEmail.split("@");
  log.info(`Active tasks for agent ${agentId}: ${tasks.length} tasks`);
  return tasks.map((t) => ({
    taskId: t.taskId,
    tag: t.tag,
    taskEmail: `${localPart}+${t.tag}@${domain}`,
    objective: t.objective,
    status: t.status,
  }));
}

// --- Conversation & turn log activities (now task-scoped) ---

export async function insertConversationMessage(
  taskId: string,
  msg: { role: string; content: string },
) {
  log.debug(`Inserting conversation message: task=${taskId} role=${msg.role} len=${msg.content.length}`);
  await prisma.conversation.create({
    data: {
      taskId,
      role: msg.role,
      message: JSON.stringify({ role: msg.role, content: msg.content, timestamp: Date.now() }),
      orderingKey: uuidv7(),
    },
  });
  await publishTurnSnapshot(taskId, []).catch((err) => {
    log.warn(`publishTurnSnapshot after insertConversationMessage failed: ${String(err)}`);
  });
}

export async function insertTurnLog(
  taskId: string,
  log_entry: {
    turnNumber: number;
    fromState: string;
    toState: string;
    trigger: string;
  },
): Promise<number> {
  log.info(`Inserting turn log: task=${taskId} turn=${log_entry.turnNumber} ${log_entry.fromState}→${log_entry.toState} trigger=${log_entry.trigger}`);
  const entry = await prisma.agentTurnLog.create({
    data: {
      taskId,
      turnNumber: log_entry.turnNumber,
      fromState: log_entry.fromState,
      toState: log_entry.toState,
      trigger: log_entry.trigger,
    },
  });
  return entry.id;
}

export async function updateTurnLogReflection(
  turnLogId: number,
  reflection: string,
) {
  log.debug(`Updating turn log reflection: id=${turnLogId} len=${reflection.length}`);
  await prisma.agentTurnLog.update({
    where: { id: turnLogId },
    data: { wakeReflection: reflection },
  });
}

export async function updateTurnLogStopReason(
  turnLogId: number,
  stopReason: string,
) {
  log.info(`Updating turn log stop reason: id=${turnLogId}`, { stopReason });
  await prisma.agentTurnLog.update({
    where: { id: turnLogId },
    data: { stopReason },
  });
}

export async function preparePromptMessages(
  taskId: string,
  input: PreparePromptMessagesInput,
): Promise<{ contextSeedMessage: string | null; wakeMessage: string }> {
  const task = await prisma.task.findUniqueOrThrow({ where: { taskId } });
  const agent = await prisma.agent.findUniqueOrThrow({ where: { agentId: task.agentId } });
  const agentDir = ensureAgentDir(agent.agentId);
  const configState = detectConfigChange(agentDir, agent);

  return {
    contextSeedMessage: input.includeContextSeed ? buildContextSeedMessage(agent, task) : null,
    wakeMessage: buildWakeMessage({
      ...input.wake,
      todoSnapshot: buildTodoSnapshotForPrompt(agentDir, task),
      configChanged: configState.changed,
      configChangedFields: configState.changedFields,
      configSnapshot: configState.changed ? configState.snapshot : undefined,
    }),
  };
}

export async function screenInboundEmailBatch(
  taskId: string,
  emails: InboundEmail[],
): Promise<ScreenInboundEmailBatchResult> {
  const messageIds = uniqueMessageIds(emails);
  if (messageIds.length === 0) {
    return { approvedMessageIds: [], rejectedMessageIds: [], decisions: [], summary: "No inbound emails to screen." };
  }

  const task = await prisma.task.findUniqueOrThrow({ where: { taskId } });
  const agent = await prisma.agent.findUniqueOrThrow({ where: { agentId: task.agentId } });

  let result: ScreenInboundEmailBatchResult;
  let emailsForScreening: EmailForScreening[];
  try {
    const screening = await withTimeout(
      (async () => {
        const agentmail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
        const fetchedEmails = await Promise.all(
          messageIds.map((messageId) => fetchEmailForScreening(agentmail, agent.agentEmail, messageId)),
        );
        return {
          emailsForScreening: fetchedEmails,
          result: await runEmailScreener({
            taskObjective: task.objective,
            ownerEmail: agent.ownerEmail,
            agentEmail: agent.agentEmail,
            emails: fetchedEmails,
          }),
        };
      })(),
      EMAIL_SCREENING_TIMEOUT_MS,
      "Email screening timed out",
    );
    emailsForScreening = screening.emailsForScreening;
    result = screening.result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error(`Email screening failed closed for task=${taskId}`, error);
    emailsForScreening = fallbackEmailsForScreening(emails);
    result = buildFailClosedScreening(emailsForScreening, `Screening failed closed: ${reason}`);
  }

  await sendOwnerAlertsForRejected(agent, result.decisions);
  return result;
}

function uniqueMessageIds(emails: InboundEmail[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    for (const messageId of email.batchMessageIds ?? [email.messageId]) {
      if (seen.has(messageId)) continue;
      seen.add(messageId);
      out.push(messageId);
    }
  }
  return out;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function coerceAddressList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return [raw];
  return [];
}

function normalizeSenderEmail(rawFrom: unknown): string {
  if (typeof rawFrom !== "string") return "";
  const trimmed = rawFrom.trim();
  const match = trimmed.match(/<([^>]+)>/);
  return (match?.[1] ?? trimmed).trim().toLowerCase();
}

async function fetchEmailForScreening(
  agentmail: AgentMailClient,
  inboxId: string,
  messageId: string,
): Promise<EmailForScreening> {
  const msg = await agentmail.inboxes.messages.get(inboxId, messageId) as unknown as Record<string, unknown>;
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  return {
    messageId,
    sender: normalizeSenderEmail(msg.from) || String(msg.from ?? ""),
    subject: typeof msg.subject === "string" ? msg.subject : null,
    threadId: typeof (msg.threadId ?? msg.thread_id) === "string" ? (msg.threadId ?? msg.thread_id) as string : null,
    to: coerceAddressList(msg.to),
    cc: coerceAddressList(msg.cc),
    timestamp: String(msg.createdAt ?? msg.created_at ?? msg.timestamp ?? new Date().toISOString()),
    labels: coerceAddressList(msg.labels),
    hasAttachments: attachments.length > 0,
    body: String(msg.extractedText ?? msg.text ?? ""),
  };
}

function fallbackEmailsForScreening(emails: InboundEmail[]): EmailForScreening[] {
  return expandInboundEmails(emails).map((email) => ({
    messageId: email.messageId,
    sender: email.sender,
    subject: null,
    threadId: null,
    to: [email.inboxId],
    cc: [],
    timestamp: email.timestamp,
    labels: [],
    hasAttachments: false,
    body: "",
  }));
}

function expandInboundEmails(emails: InboundEmail[]): Array<{
  messageId: string;
  sender: string;
  inboxId: string;
  timestamp: string;
}> {
  return emails.flatMap((email) => {
    const messageIds = email.batchMessageIds ?? [email.messageId];
    const senders = email.batchSenders ?? [email.sender];
    return messageIds.map((messageId, index) => ({
      messageId,
      sender: senders[index] ?? email.sender,
      inboxId: email.inboxId,
      timestamp: email.timestamp,
    }));
  });
}

async function sendOwnerAlertsForRejected(
  agent: { agentEmail: string; ownerEmail: string; name: string },
  decisions: ScreenedEmailDecision[],
): Promise<void> {
  const rejected = decisions.filter((decision) => decision.disposition === "reject");
  if (rejected.length === 0) return;

  const agentmail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
  for (const decision of rejected) {
    try {
      await agentmail.inboxes.messages.send(agent.agentEmail, {
        to: [agent.ownerEmail],
        subject: `Security alert: ${agent.name} rejected an email`,
        text: formatOwnerAlert(decision),
      });
    } catch (error) {
      log.error(`Failed to alert owner for rejected email ${decision.messageId}`, error);
    }
  }
}

function formatOwnerAlert(decision: ScreenedEmailDecision): string {
  return [
    "An inbound email was rejected by the security screener and withheld from the agent.",
    "",
    `Message ID: ${decision.messageId}`,
    `From: ${decision.sender || "unknown"}`,
    `Subject: ${decision.subject ?? "(no subject)"}`,
    `Risk: ${decision.riskLevel}`,
    `Categories: ${decision.categories.join(", ")}`,
    `Requested actions: ${decision.requestedActions.length ? decision.requestedActions.join(", ") : "none detected"}`,
    `Reason: ${decision.reason}`,
    "",
    "The email body was not included in this alert.",
  ].join("\n");
}

// --- Task management activities (used by root task's tools) ---

export async function startChildTaskWorkflow(
  taskId: string,
  agentId: string,
): Promise<void> {
  log.info(`Starting child task workflow: task=${taskId} agent=${agentId}`);
  const temporal = await getTemporalClient();
  await temporal.workflow.start("taskWorkflow", {
    args: [taskId, agentId],
    taskQueue: TASK_QUEUE,
    workflowId: `task-${taskId}`,
  });
  log.info(`Child task workflow started: task-${taskId}`);
}

export async function wakeTask(
  taskId: string,
  message: string,
): Promise<void> {
  const task = await prisma.task.findUniqueOrThrow({ where: { taskId } });
  if (task.status === "RUNNING") {
    throw new Error(`Task ${taskId} is already RUNNING. Sleep and retry later.`);
  }
  log.info(`Waking task: ${taskId} (status=${task.status})`, { message });

  // Insert the message into the child's conversation
  await prisma.conversation.create({
    data: {
      taskId,
      role: "user",
      message: JSON.stringify({
        role: "user",
        content: `## INLINE ROOT TASK MESSAGE
Source: root task wake

${message}`,
        timestamp: Date.now(),
      }),
      orderingKey: uuidv7(),
    },
  });
  await publishTurnSnapshot(taskId, []).catch((err) => {
    log.warn(`publishTurnSnapshot after wakeTask failed: ${String(err)}`);
  });

  // Signal the child workflow to wake
  const temporal = await getTemporalClient();
  const handle = temporal.workflow.getHandle(`task-${taskId}`);
  await handle.signal("on_owner_response", `inline:${JSON.stringify({ source: "root_task", message })}`);
  log.info(`Task ${taskId} wake signal sent`);
}

export async function cancelTask(taskId: string): Promise<void> {
  log.info(`Cancelling task: ${taskId}`);
  await prisma.task.update({
    where: { taskId },
    data: { status: "COMPLETED", completedAt: new Date(), lastActivityAt: new Date() },
  });
}

export async function listTasksForAgent(
  agentId: string,
): Promise<Array<{ taskId: string; tag: string; objective: string; status: string; lastStopReason: string | null }>> {
  const tasks = await prisma.task.findMany({
    where: { agentId, isRoot: false },
    orderBy: { createdAt: "desc" },
  });

  const results = [];
  for (const t of tasks) {
    // Get the last turn log for stopReason
    const lastLog = await prisma.agentTurnLog.findFirst({
      where: { taskId: t.taskId, stopReason: { not: null } },
      orderBy: { turnNumber: "desc" },
    });
    results.push({
      taskId: t.taskId,
      tag: t.tag,
      objective: t.objective,
      status: t.status,
      lastStopReason: lastLog?.stopReason ?? null,
    });
  }
  log.info(`Listed tasks for agent ${agentId}: ${results.length} tasks`);
  return results;
}

export async function getTaskConversation(
  taskId: string,
  limit: number = 20,
): Promise<Array<{ role: string; content: string; timestamp: number }>> {
  const messages = await prisma.conversation.findMany({
    where: { taskId },
    orderBy: { id: "desc" },
    take: limit,
  });
  // oxlint-disable-next-line no-array-reverse -- target is ES2022, toReversed requires ES2023
  return [...messages].reverse().map((m) => {
    try {
      const parsed = JSON.parse(m.message);
      return { role: parsed.role, content: parsed.content, timestamp: parsed.timestamp };
    } catch {
      return { role: m.role, content: m.message, timestamp: 0 };
    }
  });
}

// --- Schedule activities ---

export async function fireScheduleSignal(
  targetWorkflowId: string,
  scheduleId: string,
  message: string,
): Promise<void> {
  log.info(`Firing schedule signal: schedule=${scheduleId} target=${targetWorkflowId}`);
  const temporal = await getTemporalClient();
  const handle = temporal.workflow.getHandle(targetWorkflowId);
  await handle.signal(SIGNAL_SCHEDULE, scheduleId, message);
  await prisma.schedule.update({
    where: { scheduleId },
    data: { status: "FIRED" },
  });
  log.info(`Schedule fired: ${scheduleId}`);
}

export async function updateScheduleStatus(
  scheduleId: string,
  status: string,
): Promise<void> {
  log.info(`Updating schedule status: ${scheduleId} → ${status}`);
  await prisma.schedule.update({
    where: { scheduleId },
    data: { status },
  });
}

// --- AI activities (now task-scoped) ---

export async function runReflection(
  taskId: string,
  turnLogId: number,
  trigger: string,
  triggerContext: string,
  priorState: string,
  lastStopReason: string | null,
): Promise<string> {
  log.info(`Running reflection: task=${taskId} turnLog=${turnLogId} trigger=${trigger}`);
  try {
    const result = await runReflectionImpl(
      taskId,
      turnLogId,
      trigger,
      triggerContext,
      priorState,
      lastStopReason,
    );
    log.info(`Reflection completed: task=${taskId}`, { reflection: result });
    return result;
  } catch (err) {
    // Reflection is non-critical — return a fallback so the turn can proceed
    log.error(`Reflection failed (returning fallback): task=${taskId}`, err);
    return `[Reflection unavailable: ${err instanceof Error ? err.message : String(err)}] Prior state: ${priorState}. Trigger: ${trigger}. Context: ${triggerContext}`;
  }
}

export async function runPiAgentTurn(
  taskId: string,
  turnLogId: number,
  blockedEmailIds: string[] = [],
): Promise<DecisionResult> {
  log.info(`Running Pi agent turn: task=${taskId} turnLog=${turnLogId}`);
  try {
    const result = await runPiAgentTurnImpl(taskId, turnLogId, blockedEmailIds);
    log.info(`Pi agent turn completed: task=${taskId} decision=${result.type}`, { result });
    return result;
  } catch (err) {
    log.error(`Pi agent turn failed: task=${taskId}`, err);
    throw err;
  }
}

// --- Sleeping-phase reflection activities ---

export interface ActivityGateResult {
  hasActivity: boolean;
  activeChildTaskIds: string[];
  rootTurnCount: number;
  summary: string;
}

const REFLECTION_TRIGGERS = [
  "sleeping_phase",
  "sleeping_phase_no_delta",
  "sleeping_phase_child_error",
];

export async function runActivityGate(
  agentId: string,
  windowHours: number = 24,
): Promise<ActivityGateResult> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const rootTask = await prisma.task.findFirst({
    where: { agentId, isRoot: true },
  });
  if (!rootTask) {
    throw new Error(`No root task found for agent ${agentId}`);
  }

  const rootTurnCount = await prisma.agentTurnLog.count({
    where: {
      taskId: rootTask.taskId,
      timestamp: { gte: since },
      trigger: { notIn: REFLECTION_TRIGGERS },
    },
  });

  const activeChildren = await prisma.task.findMany({
    where: {
      agentId,
      isRoot: false,
      lastActivityAt: { gte: since },
    },
    orderBy: { lastActivityAt: "asc" },
    select: { taskId: true, tag: true },
  });

  const hasActivity = rootTurnCount > 0 || activeChildren.length > 0;
  const summary = hasActivity
    ? `Root took ${rootTurnCount} non-reflection turn(s); ${activeChildren.length} child task(s) active in last ${windowHours}h.`
    : `No root turns or child-task activity in last ${windowHours}h.`;

  log.info(`Activity gate: agent=${agentId} hasActivity=${hasActivity}`, {
    rootTurnCount,
    activeChildCount: activeChildren.length,
  });

  return {
    hasActivity,
    activeChildTaskIds: activeChildren.map((c) => c.taskId),
    rootTurnCount,
    summary,
  };
}

export async function runChildReflectionStep(
  childTaskId: string,
): Promise<string> {
  log.info(`Running child reflection step: task=${childTaskId}`);
  try {
    const digest = await runChildReflectionStepImpl(childTaskId);
    log.info(`Child reflection step completed: task=${childTaskId} digestLen=${digest.length}`);
    return digest;
  } catch (err) {
    log.error(`Child reflection step failed: task=${childTaskId}`, err);
    throw err;
  }
}
