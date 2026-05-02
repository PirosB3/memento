import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  upsertMemo,
} from "@temporalio/workflow";
import type {
  DecisionResult,
  InboundEmail,
  ScheduleWorkflowRuntimeSnapshot,
  TaskStatus,
  TaskWorkflowPhase,
  TaskWorkflowResumeInput,
  TaskWorkflowRuntimeSnapshot,
  WakeSource,
} from "@summon/shared/types";
import {
  QUERY_SCHEDULE_RUNTIME as QUERY_SCHEDULE_RUNTIME_NAME,
  QUERY_TASK_RUNTIME as QUERY_TASK_RUNTIME_NAME,
  SCHEDULE_RUNTIME_MEMO_KEY as SCHEDULE_RUNTIME_MEMO_KEY_NAME,
  TASK_RUNTIME_MEMO_KEY as TASK_RUNTIME_MEMO_KEY_NAME,
} from "@summon/shared/types";
import {
  normalizeReflectionTimestamp,
  reflectionIsDue,
  timeUntilNextReflection,
} from "./reflection-schedule";

interface Activities {
  loadTaskFromDb(taskId: string): Promise<{ taskId: string; agentId: string; status: string; isRoot: boolean }>;
  updateTaskStatus(taskId: string, status: string): Promise<void>;
  checkTaskExpired(taskId: string, maxDaysIdle: number): Promise<boolean>;
  insertConversationMessage(taskId: string, msg: { role: string; content: string }): Promise<void>;
  insertTurnLog(taskId: string, log: { turnNumber: number; fromState: string; toState: string; trigger: string }): Promise<number>;
  updateTurnLogReflection(turnLogId: number, reflection: string): Promise<void>;
  updateTurnLogStopReason(turnLogId: number, stopReason: string): Promise<void>;
  preparePromptMessages(
    taskId: string,
    input: {
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
    },
  ): Promise<{ contextSeedMessage: string | null; wakeMessage: string }>;
  screenInboundEmailBatch(taskId: string, emails: InboundEmail[]): Promise<ScreenInboundEmailBatchResult>;
  runReflection(
    taskId: string,
    turnLogId: number,
    trigger: string,
    triggerContext: string,
    priorState: string,
    lastStopReason: string | null,
  ): Promise<string>;
  runPiAgentTurn(taskId: string, turnLogId: number, blockedEmailIds?: string[]): Promise<DecisionResult>;
  runActivityGate(
    agentId: string,
    windowHours?: number,
  ): Promise<{
    hasActivity: boolean;
    activeChildTaskIds: string[];
    rootTurnCount: number;
    summary: string;
  }>;
  runChildReflectionStep(childTaskId: string): Promise<string>;
}

interface ScreenInboundEmailBatchResult {
  approvedMessageIds: string[];
  rejectedMessageIds: string[];
  summary: string;
}

const {
  loadTaskFromDb,
  updateTaskStatus,
  checkTaskExpired,
  insertConversationMessage,
  insertTurnLog,
  updateTurnLogReflection,
  updateTurnLogStopReason,
  preparePromptMessages,
  screenInboundEmailBatch,
  runReflection,
  runPiAgentTurn,
  runActivityGate,
  runChildReflectionStep,
} = proxyActivities<Activities>({
  startToCloseTimeout: "10m",
  retry: {
    initialInterval: "5s",
    maximumInterval: "5m",
    backoffCoefficient: 2,
    maximumAttempts: 50,
  },
});

interface ScheduleEvent {
  scheduleId: string;
  message: string;
}

type OwnerWakeEvent =
  | { kind: "email"; messageId: string }
  | { kind: "inline"; source: string; message?: string };

interface WakeDetails {
  trigger: string;
  wokenBy: WakeSource;
  triggerContext: string;
  metadata?: Array<{ label: string; value: string }>;
  actionNow: string;
}

export const onEmailSignal = defineSignal<[InboundEmail]>("on_email");
export const onOwnerResponseSignal = defineSignal<[string]>("on_owner_response");
export const onScheduleSignal = defineSignal<[string, string]>("on_schedule");
export const cancelScheduleSignal = defineSignal("cancel_schedule");

export const taskRuntimeQuery = defineQuery<TaskWorkflowRuntimeSnapshot>(
  QUERY_TASK_RUNTIME_NAME,
);
export const scheduleRuntimeQuery = defineQuery<ScheduleWorkflowRuntimeSnapshot>(
  QUERY_SCHEDULE_RUNTIME_NAME,
);

interface ScheduleActivities {
  fireScheduleSignal(targetWorkflowId: string, scheduleId: string, message: string): Promise<void>;
  updateScheduleStatus(scheduleId: string, status: string): Promise<void>;
}

const { fireScheduleSignal, updateScheduleStatus } = proxyActivities<ScheduleActivities>({
  startToCloseTimeout: "30s",
  retry: { maximumAttempts: 3 },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const ESCALATION_TIMEOUT_MS = 7 * DAY_MS;
const INLINE_WAKE_PREFIX = "inline:";
function parseOwnerWakeEvent(payload: string): OwnerWakeEvent {
  if (payload.startsWith(INLINE_WAKE_PREFIX)) {
    const inlinePayload = payload.slice(INLINE_WAKE_PREFIX.length);
    try {
      const parsed = JSON.parse(inlinePayload) as { source?: string; message?: string };
      return {
        kind: "inline",
        source: parsed.source ?? "unknown",
        message: parsed.message,
      };
    } catch {
      return {
        kind: "inline",
        source: inlinePayload || "unknown",
      };
    }
  }

  return {
    kind: "email",
    messageId: payload,
  };
}

function describeInlineWakeSource(source: string): string {
  if (source === "owner") return "owner direct message";
  if (source === "root_task") return "root task message";
  return source;
}

function isoFromNow(ms: number): string {
  return new Date(Date.now() + Math.max(0, ms)).toISOString();
}

function buildTaskMemoSnapshot(input: {
  taskId: string;
  agentId: string;
  isRoot: boolean;
  phase: TaskWorkflowPhase;
  logicalStatus: TaskStatus;
  turnNumber: number;
  lastStopReason: string | null;
  nextWakeAt: string | null;
  lastReflectionAt: string | null;
  pendingEmailCount: number;
  pendingOwnerCount: number;
  pendingScheduleCount: number;
}): TaskWorkflowRuntimeSnapshot {
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    agentId: input.agentId,
    isRoot: input.isRoot,
    phase: input.phase,
    logicalStatus: input.logicalStatus,
    turnNumber: input.turnNumber,
    lastStopReason: input.lastStopReason,
    nextWakeAt: input.nextWakeAt,
    lastReflectionAt: input.lastReflectionAt,
    pendingEmailCount: input.pendingEmailCount,
    pendingOwnerCount: input.pendingOwnerCount,
    pendingScheduleCount: input.pendingScheduleCount,
  };
}

function persistTaskSnapshot(snapshot: TaskWorkflowRuntimeSnapshot): void {
  upsertMemo({
    [TASK_RUNTIME_MEMO_KEY_NAME]: snapshot,
  });
}

function persistScheduleSnapshot(snapshot: ScheduleWorkflowRuntimeSnapshot): void {
  upsertMemo({
    [SCHEDULE_RUNTIME_MEMO_KEY_NAME]: snapshot,
  });
}

function expandEmailBatch(emails: InboundEmail[]): Array<{ messageId: string; sender: string }> {
  return emails.flatMap((email) => {
    const messageIds = email.batchMessageIds ?? [email.messageId];
    const senders = email.batchSenders ?? [email.sender];
    return messageIds.map((messageId, index) => ({
      messageId,
      sender: senders[index] ?? email.sender,
    }));
  });
}

function approvedEmailSummary(
  emails: InboundEmail[],
  screening: ScreenInboundEmailBatchResult,
): { messageIds: string[]; senders: string[] } {
  const approved = new Set(screening.approvedMessageIds);
  const expanded = expandEmailBatch(emails).filter((email) => approved.has(email.messageId));
  return {
    messageIds: expanded.map((email) => email.messageId),
    senders: expanded.map((email) => email.sender),
  };
}

async function insertPromptMessagesForTurn(
  taskId: string,
  includeContextSeed: boolean,
  wake: WakeDetails,
  priorState: string,
  lastStopReason: string | null,
  reflection: string,
): Promise<void> {
  const promptMessages = await preparePromptMessages(taskId, {
    includeContextSeed,
    wake: {
      wokenBy: wake.wokenBy,
      priorState,
      lastStopReason,
      triggerContext: wake.triggerContext,
      metadata: wake.metadata,
      reflection,
      actionNow: wake.actionNow,
    },
  });

  if (promptMessages.contextSeedMessage) {
    await insertConversationMessage(taskId, {
      role: "user",
      content: promptMessages.contextSeedMessage,
    });
  }

  await insertConversationMessage(taskId, {
    role: "user",
    content: promptMessages.wakeMessage,
  });
}

function buildReflectionActionNow(accumulatedDigest: string): string {
  const digestBlock = accumulatedDigest.trim()
    ? accumulatedDigest.trim()
    : "(no active children — you are reflecting on root-only activity.)";

  return `You are in sleeping-phase reflection mode. You are not doing task work. You are learning from the last 24h.

## PER-CHILD REFLECTION DIGESTS (oldest activity first)
${digestBlock}

## YOUR REFLECTION TURN
1. Read memory.md. Note the most recent LAST_FEEDBACK_EMAIL line if present.
2. Consider the digest above and your own recent turns. Identify material events from the last 24h.
3. Extract AT MOST 3 high-leverage learnings. Concrete, behavior-changing. Skip vague platitudes and single-event overfitting.
4. Append the learnings to memory.md (prefer append over overwrite).
5. If a learning warrants a SOUL / BOUNDARIES / TOOLS change, call agent_config. Maximum ONE config mutation this turn. Add a "CONFIG_CHANGE: <field> — <one-line rationale>" line to memory.md.
6. If owner feedback would materially improve future behavior AND the most recent LAST_FEEDBACK_EMAIL in memory.md is older than 7 days (or absent), send ONE short email to the owner via send_email with 1-3 targeted questions (e.g. what went well, what I got wrong, what to do more or less of). Then write "LAST_FEEDBACK_EMAIL: <ISO timestamp>" to memory.md. Otherwise DO NOT send an email.
7. End the turn with decide("sleep").

## HARD GUARDRAILS
- Do NOT spawn tasks, wake tasks, or cancel tasks this turn.
- Do NOT create schedules this turn.
- Do NOT reply to emails or send non-feedback emails this turn.
- At most 3 learnings, 1 config mutation, 1 feedback email (rate-limit enforced via memory.md).
- No reassurance questions to the owner. Feedback questions must target concrete decisions or preferences.`;
}

async function processReflectionChain(
  rootTaskId: string,
  agentId: string,
  turnState: { turnNumber: number; lastStopReason: string | null },
  setRunningState: () => Promise<void>,
  lastReflectionAt: { value: string | null },
): Promise<DecisionResult | null> {
  const gate = await runActivityGate(agentId, 24);

  if (!gate.hasActivity) {
    turnState.turnNumber++;
    const turnLogId = await insertTurnLog(rootTaskId, {
      turnNumber: turnState.turnNumber,
      fromState: "SLEEPING",
      toState: "SLEEPING",
      trigger: "sleeping_phase_no_delta",
    });
    await updateTurnLogReflection(turnLogId, `no material activity in 24h — skipped (${gate.summary})`);
    await updateTurnLogStopReason(turnLogId, "sleeping_phase_no_delta");
    lastReflectionAt.value = new Date().toISOString();
    return null;
  }

  const childIds = gate.activeChildTaskIds;
  const settled = await Promise.all(
    childIds.map(async (childTaskId) => {
      try {
        const digest = await runChildReflectionStep(childTaskId);
        return { childTaskId, ok: true as const, digest };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { childTaskId, ok: false as const, message };
      }
    }),
  );

  let accumulatedDigest = "";
  for (const r of settled) {
    accumulatedDigest += r.ok
      ? `\n\n### task:${r.childTaskId}\n${r.digest}`
      : `\n\n### task:${r.childTaskId}\n(child reflection failed: ${r.message})`;
  }

  for (const r of settled) {
    if (r.ok) continue;
    turnState.turnNumber++;
    const errTurnLogId = await insertTurnLog(rootTaskId, {
      turnNumber: turnState.turnNumber,
      fromState: "SLEEPING",
      toState: "SLEEPING",
      trigger: "sleeping_phase_child_error",
    });
    await updateTurnLogStopReason(
      errTurnLogId,
      `child reflection failed for ${r.childTaskId}: ${r.message}`,
    );
  }

  const reflectionWake: WakeDetails = {
    trigger: "sleeping_phase",
    wokenBy: "sleep",
    triggerContext: `Nightly sleeping-phase reflection. ${gate.summary}`,
    metadata: [
      { label: "ROOT_TURN_COUNT", value: String(gate.rootTurnCount) },
      { label: "ACTIVE_CHILD_COUNT", value: String(gate.activeChildTaskIds.length) },
    ],
    actionNow: buildReflectionActionNow(accumulatedDigest),
  };

  const decision = await processWakeTurn(rootTaskId, reflectionWake, {
    includeContextSeed: false,
    priorState: "SLEEPING",
    turnState,
    setRunningState,
  });
  lastReflectionAt.value = new Date().toISOString();
  return decision;
}

async function processWakeTurn(
  taskId: string,
  wake: WakeDetails,
  options: {
    includeContextSeed: boolean;
    priorState: string;
    turnState: { turnNumber: number; lastStopReason: string | null };
    setRunningState: () => Promise<void>;
    blockedEmailIds?: string[];
  },
): Promise<DecisionResult> {
  options.turnState.turnNumber++;
  const turnLogId = await insertTurnLog(taskId, {
    turnNumber: options.turnState.turnNumber,
    fromState: options.priorState,
    toState: "RUNNING",
    trigger: wake.trigger,
  });

  await options.setRunningState();

  const reflection = await runReflection(
    taskId,
    turnLogId,
    wake.trigger,
    wake.triggerContext,
    options.priorState,
    options.turnState.lastStopReason,
  );
  await updateTurnLogReflection(turnLogId, reflection);
  await insertPromptMessagesForTurn(
    taskId,
    options.includeContextSeed,
    wake,
    options.priorState,
    options.turnState.lastStopReason,
    reflection,
  );

  const decision = await runPiAgentTurn(taskId, turnLogId, options.blockedEmailIds);
  await updateTurnLogStopReason(turnLogId, decision.stopReason);
  options.turnState.lastStopReason = decision.stopReason;
  return decision;
}

export async function scheduleTimerWorkflow(
  scheduleId: string,
  targetWorkflowId: string,
  fireAtMs: number,
  message: string,
): Promise<void> {
  let cancelled = false;
  const runtimeState: ScheduleWorkflowRuntimeSnapshot = {
    schemaVersion: 1,
    scheduleId,
    targetWorkflowId,
    fireAt: new Date(fireAtMs).toISOString(),
    message,
    status: "PENDING",
  };

  const currentSnapshot = () => ({ ...runtimeState });
  persistScheduleSnapshot(currentSnapshot());
  setHandler(scheduleRuntimeQuery, currentSnapshot);
  setHandler(cancelScheduleSignal, () => {
    cancelled = true;
  });

  const delay = Math.max(0, fireAtMs - Date.now());
  const gotCancelled = await condition(() => cancelled, delay);

  if (gotCancelled) {
    runtimeState.status = "CANCELLED";
    persistScheduleSnapshot(currentSnapshot());
    await updateScheduleStatus(scheduleId, "CANCELLED");
    return;
  }

  runtimeState.status = "FIRED";
  persistScheduleSnapshot(currentSnapshot());
  await fireScheduleSignal(targetWorkflowId, scheduleId, message);
}

export async function taskWorkflow(
  taskId: string,
  agentId: string,
  resumeInput: TaskWorkflowResumeInput | null = null,
): Promise<void> {
  const emailQueue: InboundEmail[] = [];
  const scheduleQueue: ScheduleEvent[] = [];
  const ownerQueue: string[] = [];
  const turnState = {
    turnNumber: resumeInput?.resumedFrom?.turnNumber ?? 0,
    lastStopReason: resumeInput?.resumedFrom?.lastStopReason ?? null as string | null,
  };
  const lastReflectionAt: { value: string | null } = {
    value: normalizeReflectionTimestamp(resumeInput?.resumedFrom?.lastReflectionAt),
  };

  setHandler(onEmailSignal, (email: InboundEmail) => {
    emailQueue.push(email);
  });
  setHandler(onOwnerResponseSignal, (messageId: string) => {
    ownerQueue.push(messageId);
  });
  setHandler(onScheduleSignal, (scheduleId: string, message: string) => {
    scheduleQueue.push({ scheduleId, message });
  });

  const task = await loadTaskFromDb(taskId);
  const isRoot = task.isRoot;
  const runtimeState = {
    phase: (resumeInput?.resumedFrom?.phase ?? "CREATED") as TaskWorkflowPhase,
    logicalStatus: (resumeInput?.resumedFrom?.logicalStatus ?? (task.status as TaskStatus)) as TaskStatus,
    nextWakeAt: resumeInput?.resumedFrom?.nextWakeAt ?? null as string | null,
  };

  const currentSnapshot = (): TaskWorkflowRuntimeSnapshot =>
    buildTaskMemoSnapshot({
      taskId,
      agentId,
      isRoot,
      phase: runtimeState.phase,
      logicalStatus: runtimeState.logicalStatus,
      turnNumber: turnState.turnNumber,
      lastStopReason: turnState.lastStopReason,
      nextWakeAt: runtimeState.nextWakeAt,
      lastReflectionAt: lastReflectionAt.value,
      pendingEmailCount: emailQueue.length,
      pendingOwnerCount: ownerQueue.length,
      pendingScheduleCount: scheduleQueue.length,
    });

  const persistRuntime = (): void => {
    persistTaskSnapshot(currentSnapshot());
  };

  const setRunningState = async (): Promise<void> => {
    runtimeState.phase = "RUNNING";
    runtimeState.logicalStatus = "RUNNING";
    runtimeState.nextWakeAt = null;
    await updateTaskStatus(taskId, "RUNNING");
    persistRuntime();
  };

  const setSleepingState = async (sleepMs: number): Promise<void> => {
    runtimeState.phase = "SLEEPING";
    runtimeState.logicalStatus = "SLEEPING";
    runtimeState.nextWakeAt = isoFromNow(sleepMs);
    await updateTaskStatus(taskId, "SLEEPING");
    persistRuntime();
  };

  const setEscalatedState = async (): Promise<void> => {
    runtimeState.phase = "ESCALATED";
    runtimeState.logicalStatus = "ESCALATED";
    runtimeState.nextWakeAt = isoFromNow(ESCALATION_TIMEOUT_MS);
    await updateTaskStatus(taskId, "ESCALATED");
    persistRuntime();
  };

  const setCompletedState = async (phase: TaskWorkflowPhase = "COMPLETED"): Promise<void> => {
    runtimeState.phase = phase;
    runtimeState.logicalStatus = "COMPLETED";
    runtimeState.nextWakeAt = null;
    await updateTaskStatus(taskId, "COMPLETED");
    persistRuntime();
  };

  setHandler(taskRuntimeQuery, currentSnapshot);
  persistRuntime();

  if (resumeInput?.resumedFrom) {
    const previousPhase = resumeInput.resumedFrom.phase;
    const restartWake: WakeDetails = {
      trigger: "restart",
      wokenBy: "restart",
      triggerContext: `Workflow execution restarted after being stopped while in ${previousPhase}. Resume from the persisted conversation and current database state.`,
      metadata: [
        { label: "PREVIOUS_PHASE", value: previousPhase },
        ...(resumeInput.previousRunId ? [{ label: "PREVIOUS_RUN_ID", value: resumeInput.previousRunId }] : []),
        ...(resumeInput.resumedFrom.nextWakeAt ? [{ label: "PREVIOUS_NEXT_WAKE_AT", value: resumeInput.resumedFrom.nextWakeAt }] : []),
      ],
      actionNow: isRoot
        ? "Read the current conversation and child task state, then decide what the root task should do next."
        : "Read the current conversation and continue the task from the latest available state.",
    };

    const restartDecision = await processWakeTurn(taskId, restartWake, {
      includeContextSeed: true,
      priorState: previousPhase,
      turnState,
      setRunningState,
    });

    if (!isRoot && (restartDecision.type === "complete" || restartDecision.type === "fail")) {
      await setCompletedState();
      await dormantLoop(
        taskId,
        agentId,
        isRoot,
        emailQueue,
        scheduleQueue,
        ownerQueue,
        turnState,
        lastReflectionAt,
        persistRuntime,
        setRunningState,
        setCompletedState,
        runtimeState,
      );
      return;
    }

    await activeLoop(
      taskId,
      agentId,
      isRoot,
      emailQueue,
      scheduleQueue,
      ownerQueue,
      turnState,
      restartDecision,
      lastReflectionAt,
      {
        persistRuntime,
        setRunningState,
        setSleepingState,
        setEscalatedState,
        setCompletedState,
        runtimeState,
      },
    );

    await dormantLoop(
      taskId,
      agentId,
      isRoot,
      emailQueue,
      scheduleQueue,
      ownerQueue,
      turnState,
      lastReflectionAt,
      persistRuntime,
      setRunningState,
      setCompletedState,
      runtimeState,
    );
    return;
  }

  const firstWake: WakeDetails = {
    trigger: "created",
    wokenBy: "created",
    triggerContext: "Task just created. Starting fresh.",
    actionNow: isRoot
      ? "Set up the workspace, initialize memory files if missing, and prepare to help the owner."
      : "Read the context seed, inspect relevant workspace files, and begin the first concrete action for the task.",
  };

  const firstDecision = await processWakeTurn(taskId, firstWake, {
    includeContextSeed: true,
    priorState: "CREATED",
    turnState,
    setRunningState,
  });

  if (!isRoot && (firstDecision.type === "complete" || firstDecision.type === "fail")) {
    await setCompletedState();
    await dormantLoop(
      taskId,
      agentId,
      isRoot,
      emailQueue,
      scheduleQueue,
      ownerQueue,
      turnState,
      lastReflectionAt,
      persistRuntime,
      setRunningState,
      setCompletedState,
      runtimeState,
    );
    return;
  }

  await activeLoop(
    taskId,
    agentId,
    isRoot,
    emailQueue,
    scheduleQueue,
    ownerQueue,
    turnState,
    firstDecision,
    lastReflectionAt,
    {
      persistRuntime,
      setRunningState,
      setSleepingState,
      setEscalatedState,
      setCompletedState,
      runtimeState,
    },
  );

  await dormantLoop(
    taskId,
    agentId,
    isRoot,
    emailQueue,
    scheduleQueue,
    ownerQueue,
    turnState,
    lastReflectionAt,
    persistRuntime,
    setRunningState,
    setCompletedState,
    runtimeState,
  );
}

async function activeLoop(
  taskId: string,
  agentId: string,
  isRoot: boolean,
  emailQueue: InboundEmail[],
  scheduleQueue: ScheduleEvent[],
  ownerQueue: string[],
  turnState: { turnNumber: number; lastStopReason: string | null },
  initialDecision: DecisionResult,
  lastReflectionAt: { value: string | null },
  runtime: {
    persistRuntime: () => void;
    setRunningState: () => Promise<void>;
    setSleepingState: (sleepMs: number) => Promise<void>;
    setEscalatedState: () => Promise<void>;
    setCompletedState: (phase?: TaskWorkflowPhase) => Promise<void>;
    runtimeState: { phase: TaskWorkflowPhase; logicalStatus: TaskStatus; nextWakeAt: string | null };
  },
): Promise<void> {
  let decision = initialDecision;
  let currentState = "SLEEPING";
  turnState.lastStopReason = initialDecision.stopReason;

  while (true) {
    const baseSleepMs = decision.sleepDurationMs ?? DAY_MS;
    const now = new Date();
    const reflectionBoundMs = isRoot
      ? timeUntilNextReflection(now, lastReflectionAt.value)
      : Number.POSITIVE_INFINITY;
    const sleepMs = Math.min(baseSleepMs, reflectionBoundMs);

    await runtime.setSleepingState(sleepMs);
    currentState = "SLEEPING";

    await condition(
      () => emailQueue.length > 0 || ownerQueue.length > 0 || scheduleQueue.length > 0,
      sleepMs,
    );

    if (
      isRoot &&
      emailQueue.length === 0 &&
      ownerQueue.length === 0 &&
      scheduleQueue.length === 0 &&
      reflectionIsDue(new Date(), lastReflectionAt.value)
    ) {
      const reflectionDecision = await processReflectionChain(
        taskId,
        agentId,
        turnState,
        runtime.setRunningState,
        lastReflectionAt,
      );
      if (reflectionDecision) {
        decision = reflectionDecision;
        currentState = "RUNNING";
        if (decision.type === "escalate") {
          await runtime.setEscalatedState();
          currentState = "ESCALATED";
          const gotResponse = await condition(() => ownerQueue.length > 0, ESCALATION_TIMEOUT_MS);
          if (!gotResponse) {
            continue;
          }
          // Fall through to next iteration — the owner response will be drained there.
        }
      }
      continue;
    }

    let wake: WakeDetails;
    let blockedEmailIdsForTurn: string[] | undefined;

    if (ownerQueue.length > 0) {
      const ownerWake = parseOwnerWakeEvent(ownerQueue.shift()!);
      if (ownerWake.kind === "email") {
        wake = {
          trigger: "owner_response",
          wokenBy: "owner",
          triggerContext: "Owner sent a message.",
          metadata: [{ label: "MESSAGE_ID", value: ownerWake.messageId }],
          actionNow: "Use read_email with the MESSAGE_ID above to read the owner email, then act on it.",
        };
      } else {
        const inlineContext = ownerWake.message
          ? `Received an inline wake from ${describeInlineWakeSource(ownerWake.source)} with message: ${ownerWake.message}`
          : `Received an inline wake from ${describeInlineWakeSource(ownerWake.source)}.`;
        wake = {
          trigger: "owner_response",
          wokenBy: ownerWake.source === "root_task" ? "root_task" : "owner",
          triggerContext: inlineContext,
          metadata: [
            { label: "SOURCE", value: ownerWake.source },
            ...(ownerWake.message ? [{ label: "INLINE_MESSAGE", value: ownerWake.message }] : []),
          ],
          actionNow: ownerWake.message
            ? `Act on the inline instruction: ${ownerWake.message}`
            : `Act on the inline instruction from ${describeInlineWakeSource(ownerWake.source)}.`,
        };
      }
    } else if (scheduleQueue.length > 0) {
      const schedules = scheduleQueue.splice(0);
      wake = {
        trigger: "schedule",
        wokenBy: "schedule",
        triggerContext: `${schedules.length} scheduled timer(s) fired.`,
        metadata: [
          { label: "SCHEDULE_IDS", value: schedules.map((sched) => sched.scheduleId).join(", ") },
          { label: "REMINDERS", value: schedules.map((sched) => sched.message).join(" | ") },
        ],
        actionNow: `Act on the scheduled reminder(s): ${schedules.map((sched) => `"${sched.message}"`).join(", ")}.`,
      };
    } else if (emailQueue.length > 0) {
      const emails = emailQueue.splice(0);
      const screening = await screenInboundEmailBatch(taskId, emails);
      if (screening.approvedMessageIds.length === 0) {
        turnState.lastStopReason = screening.summary;
        continue;
      }
      blockedEmailIdsForTurn = screening.rejectedMessageIds;
      const approved = approvedEmailSummary(emails, screening);
      wake = {
        trigger: "email",
        wokenBy: "email",
        triggerContext: `Received ${approved.messageIds.length} approved email(s) from: ${approved.senders.join(", ")}. ${screening.rejectedMessageIds.length} email(s) were rejected by the security screener.`,
        metadata: [
          { label: "MESSAGE_IDS", value: approved.messageIds.join(", ") },
          { label: "SENDERS", value: approved.senders.join(", ") },
          { label: "EMAIL_SCREENING", value: screening.summary },
        ],
        actionNow: "Use read_email only with the approved MESSAGE_IDS above, then respond holistically.",
      };
    } else {
      wake = {
        trigger: "sleep_timeout",
        wokenBy: "sleep",
        triggerContext: `Sleep timer expired after ${sleepMs}ms. No new emails received.`,
        metadata: [{ label: "SLEEP_DURATION_MS", value: String(sleepMs) }],
        actionNow: isRoot
          ? "Check on child tasks with list_tasks() and decide whether to steer, spawn, or sleep again."
          : "Review the TODO snapshot. If [ACTIONABLE] contains items, do the next one now. Use sleep only when [ACTIONABLE] is empty. If you are stuck or blocked, escalate to the owner instead of sleeping.",
      };
    }

    decision = await processWakeTurn(taskId, wake, {
      includeContextSeed: false,
      priorState: currentState,
      turnState,
      setRunningState: runtime.setRunningState,
      blockedEmailIds: blockedEmailIdsForTurn,
    });
    currentState = "RUNNING";

    if (!isRoot && (decision.type === "complete" || decision.type === "fail")) {
      await runtime.setCompletedState();
      return;
    }

    if (decision.type === "escalate") {
      await runtime.setEscalatedState();
      currentState = "ESCALATED";

      const gotResponse = await condition(() => ownerQueue.length > 0, ESCALATION_TIMEOUT_MS);
      if (!gotResponse) {
        await runtime.setSleepingState(decision.sleepDurationMs ?? DAY_MS);
        currentState = "SLEEPING";
        continue;
      }

      const ownerWake = parseOwnerWakeEvent(ownerQueue.shift()!);
      let escalationWake: WakeDetails;

      if (ownerWake.kind === "email") {
        escalationWake = {
          trigger: "owner_response",
          wokenBy: "owner",
          triggerContext: "Owner responded to escalation.",
          metadata: [{ label: "MESSAGE_ID", value: ownerWake.messageId }],
          actionNow: "Use read_email with the MESSAGE_ID above to read the owner's escalation response, then proceed.",
        };
      } else {
        const inlineContext = ownerWake.message
          ? `Received an inline wake from ${describeInlineWakeSource(ownerWake.source)} while escalated: ${ownerWake.message}`
          : `Received an inline wake from ${describeInlineWakeSource(ownerWake.source)} while escalated.`;
        escalationWake = {
          trigger: "owner_response",
          wokenBy: ownerWake.source === "root_task" ? "root_task" : "owner",
          triggerContext: inlineContext,
          metadata: [
            { label: "SOURCE", value: ownerWake.source },
            ...(ownerWake.message ? [{ label: "INLINE_MESSAGE", value: ownerWake.message }] : []),
          ],
          actionNow: ownerWake.message
            ? `Resolve the escalation using the inline instruction: ${ownerWake.message}`
            : `Resolve the escalation using the inline instruction from ${describeInlineWakeSource(ownerWake.source)}.`,
        };
      }

      decision = await processWakeTurn(taskId, escalationWake, {
        includeContextSeed: false,
        priorState: "ESCALATED",
        turnState,
        setRunningState: runtime.setRunningState,
      });

      if (!isRoot && (decision.type === "complete" || decision.type === "fail")) {
        await runtime.setCompletedState();
        return;
      }
    }
  }
}

async function dormantLoop(
  taskId: string,
  agentId: string,
  isRoot: boolean,
  emailQueue: InboundEmail[],
  scheduleQueue: ScheduleEvent[],
  ownerQueue: string[],
  turnState: { turnNumber: number; lastStopReason: string | null },
  lastReflectionAt: { value: string | null },
  persistRuntime: () => void,
  setRunningState: () => Promise<void>,
  setCompletedState: (phase?: TaskWorkflowPhase) => Promise<void>,
  runtimeState: { phase: TaskWorkflowPhase; logicalStatus: TaskStatus; nextWakeAt: string | null },
): Promise<void> {
  const MAX_IDLE_DAYS = 30;

  while (true) {
    runtimeState.phase = "DORMANT";
    runtimeState.logicalStatus = "COMPLETED";
    runtimeState.nextWakeAt = isoFromNow(DAY_MS);
    persistRuntime();

    const gotSignal = await condition(
      () => emailQueue.length > 0 || ownerQueue.length > 0 || scheduleQueue.length > 0,
      DAY_MS,
    );

    if (!gotSignal) {
      const expired = await checkTaskExpired(taskId, MAX_IDLE_DAYS);
      if (expired) return;
      continue;
    }

    let wake: WakeDetails;
    let blockedEmailIdsForTurn: string[] | undefined;

    if (ownerQueue.length > 0) {
      const ownerWake = parseOwnerWakeEvent(ownerQueue.shift()!);
      if (ownerWake.kind === "email") {
        wake = {
          trigger: "owner_response",
          wokenBy: "owner",
          triggerContext: "Owner sent a message to completed task. Reanimating.",
          metadata: [{ label: "MESSAGE_ID", value: ownerWake.messageId }],
          actionNow: "Use read_email with the MESSAGE_ID above to inspect the owner's new request and decide whether to resume work.",
        };
      } else {
        const inlineContext = ownerWake.message
          ? `Received an inline wake from ${describeInlineWakeSource(ownerWake.source)} for a completed task: ${ownerWake.message}`
          : `Received an inline wake from ${describeInlineWakeSource(ownerWake.source)} for a completed task. Reanimating.`;
        wake = {
          trigger: "owner_response",
          wokenBy: ownerWake.source === "root_task" ? "root_task" : "owner",
          triggerContext: inlineContext,
          metadata: [
            { label: "SOURCE", value: ownerWake.source },
            ...(ownerWake.message ? [{ label: "INLINE_MESSAGE", value: ownerWake.message }] : []),
          ],
          actionNow: ownerWake.message
            ? `Use the inline instruction to decide whether to resume the completed task: ${ownerWake.message}`
            : `Use the inline instruction from ${describeInlineWakeSource(ownerWake.source)} to decide whether to resume work.`,
        };
      }
    } else if (scheduleQueue.length > 0) {
      const schedules = scheduleQueue.splice(0);
      wake = {
        trigger: "schedule",
        wokenBy: "schedule",
        triggerContext: `${schedules.length} scheduled timer(s) fired on completed task. Reanimating.`,
        metadata: [
          { label: "SCHEDULE_IDS", value: schedules.map((sched) => sched.scheduleId).join(", ") },
          { label: "REMINDERS", value: schedules.map((sched) => sched.message).join(" | ") },
        ],
        actionNow: `Review the scheduled reminder(s) and determine whether the completed task should resume: ${schedules.map((sched) => `"${sched.message}"`).join(", ")}.`,
      };
    } else {
      const emails = emailQueue.splice(0);
      const screening = await screenInboundEmailBatch(taskId, emails);
      if (screening.approvedMessageIds.length === 0) {
        turnState.lastStopReason = screening.summary;
        continue;
      }
      blockedEmailIdsForTurn = screening.rejectedMessageIds;
      const approved = approvedEmailSummary(emails, screening);
      wake = {
        trigger: "email",
        wokenBy: "email",
        triggerContext: `Received ${approved.messageIds.length} approved email(s) to completed task. Reanimating. ${screening.rejectedMessageIds.length} email(s) were rejected by the security screener.`,
        metadata: [
          { label: "MESSAGE_IDS", value: approved.messageIds.join(", ") },
          { label: "SENDERS", value: approved.senders.join(", ") },
          { label: "EMAIL_SCREENING", value: screening.summary },
        ],
        actionNow: "Use read_email only with the approved MESSAGE_IDS above, then decide whether to resume the task.",
      };
    }

    const decision = await processWakeTurn(taskId, wake, {
      includeContextSeed: false,
      priorState: "COMPLETED",
      turnState,
      setRunningState,
      blockedEmailIds: blockedEmailIdsForTurn,
    });

    if (decision.type === "complete" || decision.type === "fail") {
      await setCompletedState();
      continue;
    }

    await activeLoop(
      taskId,
      agentId,
      isRoot,
      emailQueue,
      scheduleQueue,
      ownerQueue,
      turnState,
      decision,
      lastReflectionAt,
      {
        persistRuntime,
        setRunningState,
        setSleepingState: async (sleepMs: number) => {
          runtimeState.phase = "SLEEPING";
          runtimeState.logicalStatus = "SLEEPING";
          runtimeState.nextWakeAt = isoFromNow(sleepMs);
          await updateTaskStatus(taskId, "SLEEPING");
          persistRuntime();
        },
        setEscalatedState: async () => {
          runtimeState.phase = "ESCALATED";
          runtimeState.logicalStatus = "ESCALATED";
          runtimeState.nextWakeAt = isoFromNow(ESCALATION_TIMEOUT_MS);
          await updateTaskStatus(taskId, "ESCALATED");
          persistRuntime();
        },
        setCompletedState,
        runtimeState,
      },
    );
  }
}
