import crypto from "crypto";
import { SIGNAL_OWNER, publishTurnSnapshot } from "@summon/shared";
import { uuidv7 } from "uuidv7";
import { getWebServiceDependencies } from "./dependencies";
import type { WebServiceDependencies } from "./dependencies";
import { parseJsonArray } from "./json";
import {
  getTaskWorkflowRuntime,
  restartTaskWorkflow,
  stopTaskWorkflow,
} from "./workflow-control";

const INLINE_WAKE_PREFIX = "inline:";

export interface PrepareTaskInput {
  agentId: string;
  objective: string;
}

export interface CreateTaskInput extends PrepareTaskInput {
  answers?: Record<string, string>;
}

export function buildEnrichedObjective(
  objective: string,
  answers: Record<string, string> = {},
): string {
  const answersText = Object.entries(answers)
    .filter(([, answer]) => answer.trim())
    .map(([question, answer]) => `Q: ${question}\nA: ${answer}`)
    .join("\n\n");

  return answersText ? `${objective}\n\nAdditional context:\n${answersText}` : objective;
}

function requireFields(fields: Array<[string, string | undefined]>): void {
  const missing = fields
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} are required`);
  }
}

export async function prepareTask(
  input: PrepareTaskInput,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<{ questions: string[] }> {
  requireFields([
    ["agentId", input.agentId],
    ["objective", input.objective],
  ]);

  const agent = await deps.db.agent.findUnique({
    where: { agentId: input.agentId },
  });

  if (!agent) {
    throw new Error("Agent not found");
  }

  const text = await deps.llm.createText({
    model: "claude-sonnet-4-6",
    maxTokens: 1024,
    system: `You are helping configure a task for an AI agent named "${agent.name}". The agent's personality: ${agent.soul.slice(0, 200)}

Given the task objective, generate 3-5 short, targeted clarifying questions that will help the agent execute the task effectively. Focus on:
- Key details missing from the objective (names, dates, preferences)
- Constraints or priorities
- How to handle edge cases
- Tone or approach preferences specific to this task

Keep questions concise. Return ONLY a JSON array of question strings. No other text.`,
    prompt: `Task objective: ${input.objective}`,
  });

  return { questions: parseJsonArray(text) };
}

export async function createTask(
  input: CreateTaskInput,
  deps: WebServiceDependencies = getWebServiceDependencies(),
) {
  requireFields([
    ["agentId", input.agentId],
    ["objective", input.objective],
  ]);

  const agent = await deps.db.agent.findUnique({
    where: { agentId: input.agentId },
  });

  if (!agent) {
    throw new Error("Agent not found");
  }

  const rootTask = await deps.db.task.findFirst({
    where: { agentId: input.agentId, isRoot: true },
  });
  if (!rootTask) {
    throw new Error("Root task not found");
  }

  const rootRuntime = await getTaskWorkflowRuntime(rootTask, deps);
  if (rootRuntime.workflowStatus === "STOPPED") {
    throw new Error("Agent workflow is stopped. Restart it before creating tasks.");
  }

  const taskId = crypto.randomUUID();
  const objective = buildEnrichedObjective(input.objective, input.answers);

  const task = await deps.db.task.create({
    data: {
      taskId,
      agentId: input.agentId,
      tag: taskId,
      objective,
      status: "RUNNING",
      isRoot: false,
    },
  });

  try {
    const started = await deps.workflows.startTaskWorkflow({
      taskId,
      agentId: input.agentId,
      workflowId: `task-${taskId}`,
    });
    await deps.db.task.update({
      where: { taskId },
      data: { temporalRunId: started.firstExecutionRunId },
    });
  } catch {
    // Keep DB row even if workflow start fails, matching current behavior.
  }

  return task;
}

export async function stopTask(
  agentId: string,
  taskId: string,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<void> {
  await stopTaskWorkflow(agentId, taskId, deps);
}

export async function restartTask(
  agentId: string,
  taskId: string,
  message?: string,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<void> {
  const trimmedMessage = message?.trim();

  if (!trimmedMessage) {
    await restartTaskWorkflow(agentId, taskId, deps);
    return;
  }

  // Atomic restart-with-message: stop → insert owner message → restart.
  // Inserting the message into the conversation BEFORE startTaskWorkflow
  // means the new run's turn 1 picks it up via preparePromptMessages. If we
  // signalled SIGNAL_OWNER instead, the signal would race turn 1 and produce
  // a second turn — duplicate side effects (see CLAUDE.md note).
  await stopTaskWorkflow(agentId, taskId, deps);
  await insertImmediateWakeMessage(
    taskId,
    buildDirectOwnerWakeMessage(trimmedMessage),
    deps,
  );
  await restartTaskWorkflow(agentId, taskId, deps);
}

function buildDirectOwnerWakeMessage(message: string): string {
  return `## INLINE OWNER MESSAGE
Source: direct owner wake

${message}`;
}

async function insertImmediateWakeMessage(
  taskId: string,
  content: string,
  deps: WebServiceDependencies,
): Promise<void> {
  await deps.db.conversation.create({
    data: {
      taskId,
      role: "user",
      message: JSON.stringify({
        role: "user",
        content,
        timestamp: Date.now(),
      }),
      orderingKey: uuidv7(),
    },
  });
  await publishTurnSnapshot(taskId, []).catch(() => {
    // Best-effort: failure to notify just means a connected SSE client will
    // pick up the new row on its next 2s poll instead of immediately.
  });
}

export async function wakeRootTask(
  agentId: string,
  message: string,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<void> {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new Error("message is required");
  }

  const rootTask = await deps.db.task.findFirst({
    where: { agentId, isRoot: true },
  });
  if (!rootTask) {
    throw new Error("Root task not found");
  }

  const rootRuntime = await getTaskWorkflowRuntime(rootTask, deps);
  if (rootRuntime.workflowStatus === "STOPPED") {
    throw new Error("Workflow is stopped. Restart it first.");
  }

  await insertImmediateWakeMessage(rootTask.taskId, buildDirectOwnerWakeMessage(trimmedMessage), deps);
  await deps.workflows.signalWorkflow(
    `agent__${agentId}__root`,
    SIGNAL_OWNER,
    `${INLINE_WAKE_PREFIX}${JSON.stringify({ source: "owner", message: trimmedMessage })}`,
  );
}

export async function wakeTask(
  agentId: string,
  taskId: string,
  message: string,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<void> {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new Error("message is required");
  }

  const task = await deps.db.task.findUnique({ where: { taskId } });
  if (!task || task.agentId !== agentId || task.isRoot) {
    throw new Error("Task not found");
  }

  const taskRuntime = await getTaskWorkflowRuntime(task, deps);
  if (taskRuntime.workflowStatus === "STOPPED") {
    throw new Error("Workflow is stopped. Restart it first.");
  }

  await insertImmediateWakeMessage(taskId, buildDirectOwnerWakeMessage(trimmedMessage), deps);
  await deps.workflows.signalWorkflow(
    `task-${taskId}`,
    SIGNAL_OWNER,
    `${INLINE_WAKE_PREFIX}${JSON.stringify({ source: "owner", message: trimmedMessage })}`,
  );
}
