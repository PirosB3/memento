import crypto from "crypto";
import { getWebServiceDependencies } from "./dependencies";
import type { WebServiceDependencies } from "./dependencies";
import { parseJsonArray, parseJsonObject } from "./json";
import { buildAvatarPrompt } from "./avatar-generation";
import { createLogger } from "@summon/shared";

const log = createLogger("agent-services");

export interface PrepareAgentInput {
  objective: string;
  ownerEmail: string;
}

export interface GenerateAgentInput extends PrepareAgentInput {
  answers: Record<string, string>;
}

export interface CreateAgentInput {
  ownerEmail: string;
  name: string;
  soul: string;
  boundaries: string;
  tools: string;
  signatureDisplayName?: string;
  signatureDescription?: string;
}

export interface GeneratedAgentConfig {
  soul: string;
  boundaries: string;
  tools: string;
  name: string;
  signatureDescription: string;
}

export type PersistedAgent = Awaited<
  ReturnType<WebServiceDependencies["db"]["agent"]["create"]>
>;

function requireFields(fields: Array<[string, string | undefined]>): void {
  const missing = fields
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} are required`);
  }
}

export async function prepareAgent(
  input: PrepareAgentInput,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<{ questions: string[] }> {
  requireFields([
    ["objective", input.objective],
    ["ownerEmail", input.ownerEmail],
  ]);

  const text = await deps.llm.createText({
    model: "claude-opus-4-6",
    maxTokens: 1024,
    system: `You are helping a user set up a persistent AI agent that will coordinate people via email on their behalf. This agent will be long-lived and handle many tasks over time. Given the user's description of what kind of agent they want, generate 4-5 targeted clarifying questions that will help you understand:
- The agent's personality, tone, and communication style
- General constraints and behavioral boundaries
- How the agent should handle conflicts, ambiguity, or escalations
- What information is sensitive or off-limits
- The agent's general capabilities and role

Focus on the AGENT'S IDENTITY, not on any specific task. The user will assign tasks to the agent later.

Return ONLY a JSON array of question strings. No other text.`,
    prompt: `Objective: ${input.objective}\nOwner email: ${input.ownerEmail}`,
  });

  return { questions: parseJsonArray(text) };
}

export async function generateAgentConfig(
  input: GenerateAgentInput,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<GeneratedAgentConfig> {
  requireFields([
    ["objective", input.objective],
    ["ownerEmail", input.ownerEmail],
  ]);

  if (!input.answers || Object.keys(input.answers).length === 0) {
    throw new Error("answers are required");
  }

  const answersText = Object.entries(input.answers)
    .map(([question, answer]) => `Q: ${question}\nA: ${answer}`)
    .join("\n\n");

  const text = await deps.llm.createText({
    model: "claude-opus-4-6",
    maxTokens: 2048,
    system: `You are generating the configuration for an AI email agent. Based on the user's objective and their answers to clarifying questions, generate five fields:

1. **SOUL** — The agent's personality, voice, and communication style. How it writes emails, its tone, level of formality, use of humor, etc.

2. **BOUNDARIES** — Hard constraints the agent must follow. What it can and cannot do, escalation triggers, information it must not share, behavioral limits. Include specific rules from the user's answers.

3. **TOOLS** — A natural language description of what capabilities the agent has access to. For now, every agent has: email (send/receive), a bash shell (can run any command), and a filesystem working directory. Mention that it can use \`uv init --bare\` and \`uv venv\` to set up Python work in its working directory if needed. Mention any API keys or credentials the agent should know about based on the objective.

4. **NAME** — A short, friendly first name for the agent (e.g. "Fred", "Luna", "Max"). Pick something that fits the agent's personality and task.

5. **SIGNATURE_DESCRIPTION** — A single sentence, 8 to 14 words, written in the agent's voice, suitable for an email footer. Describes the agent's role to recipients in one line. Examples: "Inbox concierge for the Smith household." or "Helping you schedule meetings without the back-and-forth." No trailing period is required but not forbidden.

Return ONLY a JSON object with keys "soul", "boundaries", "tools", "name", "signatureDescription". Each value is a string. No other text.`,
    prompt: `Objective: ${input.objective}\nOwner email: ${input.ownerEmail}\n\nClarifying Q&A:\n${answersText}`,
  });

  return parseJsonObject<GeneratedAgentConfig>(text);
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function createAgentInboxWithRetry(
  baseUsername: string,
  displayName: string,
  deps: WebServiceDependencies,
  maxRetries = 5,
): Promise<string> {
  let username = baseUsername;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const inbox = await deps.mail.createInbox({ username, displayName });
      return inbox.email;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const body = (error as Record<string, unknown>)?.body as Record<string, unknown> | undefined;
      const bodyName = body?.name as string | undefined;
      if (
        message.includes("taken") ||
        message.includes("Taken") ||
        message.includes("already exists") ||
        message.includes("Conflict") ||
        bodyName === "IsTakenError"
      ) {
        username = `${baseUsername}-${attempt + 2}`;
        continue;
      }
      throw error;
    }
  }

  const randHex = crypto.randomBytes(2).toString("hex");
  const inbox = await deps.mail.createInbox({
    username: `${baseUsername}-${randHex}`,
    displayName,
  });
  return inbox.email;
}

export async function createAgent(
  input: CreateAgentInput,
  deps: WebServiceDependencies = getWebServiceDependencies(),
): Promise<PersistedAgent> {
  requireFields([
    ["ownerEmail", input.ownerEmail],
    ["name", input.name],
    ["soul", input.soul],
    ["boundaries", input.boundaries],
    ["tools", input.tools],
  ]);

  const nameSlug = slugifyName(input.name);
  const hex = crypto.randomBytes(2).toString("hex");
  const agentId = `${nameSlug}-${hex}`;
  const agentEmail = await createAgentInboxWithRetry(nameSlug, input.name, deps);
  const rootTaskId = crypto.randomUUID();

  let profileImageUrl: string | null = null;
  try {
    profileImageUrl = await deps.avatars.generateAndUploadAvatar({
      agentId,
      prompt: buildAvatarPrompt(input.name, input.soul),
    });
  } catch (error) {
    log.warn(
      `Avatar generation failed for agent ${agentId}; continuing without profile image`,
      { error: error instanceof Error ? error.message : String(error) },
    );
  }

  let temporalRunId = "failed-to-start";
  try {
    const started = await deps.workflows.startTaskWorkflow({
      taskId: rootTaskId,
      agentId,
      workflowId: `agent__${agentId}__root`,
    });
    temporalRunId = started.firstExecutionRunId;
  } catch {
    temporalRunId = "failed-to-start";
  }

  const agent = await deps.db.agent.create({
    data: {
      agentId,
      name: input.name,
      agentEmail,
      ownerEmail: input.ownerEmail,
      soul: input.soul,
      boundaries: input.boundaries,
      tools: input.tools,
      signatureDisplayName: input.signatureDisplayName ?? input.name,
      signatureDescription: input.signatureDescription ?? null,
      profileImageUrl,
      temporalRunId,
    },
  });

  await deps.db.task.create({
    data: {
      taskId: rootTaskId,
      agentId,
      tag: `root-${agentId}`,
      isRoot: true,
      objective:
        "Main thread: help the owner, manage tasks, maintain memory. You are the primary point of contact.",
      status: "RUNNING",
      temporalRunId,
    },
  });

  return agent;
}
