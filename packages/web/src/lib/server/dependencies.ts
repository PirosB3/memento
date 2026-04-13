import { Connection, Client } from "@temporalio/client";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prisma, getTemporalAddress, getWorkspaceRoot, TASK_QUEUE } from "@summon/shared";
import crypto from "crypto";
import type { TaskWorkflowResumeInput } from "@summon/shared";

export interface MailGateway {
  createInbox(params: { username: string; displayName: string }): Promise<{ email: string }>;
}

export interface LlmGateway {
  createText(params: {
    model: string;
    maxTokens: number;
    system: string;
    prompt: string;
  }): Promise<string>;
}

export interface WorkflowClient {
  startTaskWorkflow(params: {
    taskId: string;
    agentId: string;
    workflowId: string;
    resumeInput?: TaskWorkflowResumeInput | null;
  }): Promise<{ firstExecutionRunId: string }>;
  startScheduleWorkflow(params: {
    scheduleId: string;
    targetWorkflowId: string;
    fireAtMs: number;
    message: string;
  }): Promise<{ firstExecutionRunId: string }>;
  terminateWorkflow(workflowId: string, reason: string): Promise<void>;
  signalWorkflow(workflowId: string, signalName: string, ...args: unknown[]): Promise<void>;
  describeWorkflow(workflowId: string, runId?: string): Promise<unknown>;
  queryWorkflow<T>(workflowId: string, queryName: string, runId?: string): Promise<T>;
}

export interface WebServiceDependencies {
  db: typeof prisma;
  mail: MailGateway;
  llm: LlmGateway;
  workflows: WorkflowClient;
}

interface CodexCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

type AgentMailModule = {
  AgentMailClient: new (params: { apiKey: string }) => {
    inboxes: {
      create(params: { username: string; displayName: string }): Promise<{ email: string }>;
    };
  };
};

type PiAiModule = {
  completeSimple: typeof import("../../../../../repos/pi-mono/packages/ai/dist/index.js").completeSimple;
  getModel: typeof import("../../../../../repos/pi-mono/packages/ai/dist/index.js").getModel;
};

type PiAiOauthModule = {
  refreshOpenAICodexToken: typeof import("../../../../../repos/pi-mono/packages/ai/dist/oauth.js").refreshOpenAICodexToken;
};

let temporalClient: Client | null = null;
let agentMailModulePromise: Promise<AgentMailModule> | null = null;
let piAiModulePromise: Promise<PiAiModule> | null = null;
let piAiOauthModulePromise: Promise<PiAiOauthModule> | null = null;
const globalForFakeMail = globalThis as typeof globalThis & {
  __summonFakeMailUsernames?: Set<string>;
};
const importRuntimeModule = new Function("specifier", "return import(specifier)") as <T>(
  specifier: string,
) => Promise<T>;

async function getTemporalClient(): Promise<Client> {
  if (!temporalClient) {
    const connection = await Connection.connect({ address: getTemporalAddress() });
    temporalClient = new Client({ connection });
  }
  return temporalClient;
}

function isFakeMode(flag: "MAIL" | "LLM" | "WORKFLOW"): boolean {
  return process.env.SUMMON_FAKE_EXTERNALS === "1" || process.env[`SUMMON_FAKE_${flag}`] === "1";
}

function resolvePiAiDistModule(moduleName: string): string {
  return pathToFileURL(
    resolve(getWorkspaceRoot(), "repos", "pi-mono", "packages", "ai", "dist", moduleName),
  ).href;
}

function loadAgentMailModule(): Promise<AgentMailModule> {
  agentMailModulePromise ||= importRuntimeModule<AgentMailModule>("agentmail");
  return agentMailModulePromise;
}

function loadPiAiModule(): Promise<PiAiModule> {
  piAiModulePromise ||= importRuntimeModule<PiAiModule>(resolvePiAiDistModule("index.js"));
  return piAiModulePromise;
}

function loadPiAiOauthModule(): Promise<PiAiOauthModule> {
  piAiOauthModulePromise ||= importRuntimeModule<PiAiOauthModule>(
    resolvePiAiDistModule("oauth.js"),
  );
  return piAiOauthModulePromise;
}

function resolveCodexCredentialsPath(): string {
  const override = process.env.SUMMON_CODEX_CREDENTIALS_PATH;
  if (override) return override;

  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "data", "openai-codex-credentials.json");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return join(process.cwd(), "data", "openai-codex-credentials.json");
}

async function loadCodexCredentials(): Promise<CodexCredentials> {
  const credsPath = resolveCodexCredentialsPath();
  if (!existsSync(credsPath)) {
    throw new Error(
      `OpenAI Codex credentials not found at ${credsPath}. Run 'pnpm oauth:openai' first.`,
    );
  }

  const raw = readFileSync(credsPath, "utf-8");
  const creds = JSON.parse(raw) as CodexCredentials;

  if (Date.now() < creds.expires - 60_000) {
    return creds;
  }

  const { refreshOpenAICodexToken } = await loadPiAiOauthModule();
  const refreshed = await refreshOpenAICodexToken(creds.refresh);
  writeFileSync(credsPath, JSON.stringify(refreshed, null, 2) + "\n", { mode: 0o600 });
  return refreshed as unknown as CodexCredentials;
}

function createRealMailGateway(): MailGateway {
  return {
    async createInbox({ username, displayName }) {
      const { AgentMailClient } = await loadAgentMailModule();
      const client = new AgentMailClient({
        apiKey: process.env.AGENTMAIL_API_KEY!,
      });
      const inbox = await client.inboxes.create({ username, displayName });
      return { email: inbox.email };
    },
  };
}

function createFakeMailGateway(): MailGateway {
  return {
    async createInbox({ username }) {
      const reservedUsernames =
        globalForFakeMail.__summonFakeMailUsernames ??
        (globalForFakeMail.__summonFakeMailUsernames = new Set<string>());

      if (reservedUsernames.has(username)) {
        const error = new Error(`Inbox username ${username} is already taken`);
        (error as Error & { body?: { name: string } }).body = { name: "IsTakenError" };
        throw error;
      }

      reservedUsernames.add(username);
      return { email: `${username}@agentmail.test` };
    },
  };
}

function mapAnthropicModelToCodex(model: string): string {
  // Map legacy Anthropic model names to ChatGPT subscription equivalents.
  // Heavyweight prompts (agent generation) get gpt-5.4; everything else uses the cheap mini.
  if (model.includes("opus")) return "gpt-5.4";
  return "gpt-5.1-codex-mini";
}

function createRealLlmGateway(): LlmGateway {
  return {
    async createText({ model, maxTokens, system, prompt }) {
      const { completeSimple, getModel } = await loadPiAiModule();
      const creds = await loadCodexCredentials();
      const codexModelId = mapAnthropicModelToCodex(model);
      const codexModel = getModel("openai-codex" as never, codexModelId as never) as never;

      const response = await completeSimple(
        codexModel,
        {
          systemPrompt: system,
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens, apiKey: creds.access },
      );

      if ((response as { stopReason?: string }).stopReason === "error") {
        const errMsg = (response as { errorMessage?: string }).errorMessage ?? "unknown";
        throw new Error(`Codex LLM errored: ${errMsg}`);
      }

      const content = (response as { content: Array<{ type: string; text?: string }> }).content;
      return content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n")
        .trim();
    },
  };
}

function buildFakeQuestions(prompt: string): string[] {
  if (prompt.includes("Owner email")) {
    return [
      "What tone should the agent use with other people?",
      "What topics should always trigger escalation to you?",
      "Are there any people or organizations the agent should avoid contacting?",
      "What details should the agent treat as sensitive?",
    ];
  }

  return [
    "Who are the key people involved?",
    "What deadline or timing matters most?",
    "What tradeoffs or priorities should the agent optimize for?",
  ];
}

function createFakeLlmGateway(): LlmGateway {
  return {
    async createText({ system, prompt }) {
      if (system.includes("Return ONLY a JSON array of question strings")) {
        return JSON.stringify(buildFakeQuestions(prompt));
      }

      return JSON.stringify({
        soul: "A calm, proactive operator who writes clearly and follows through on details.",
        boundaries: "Escalate when requests are ambiguous, sensitive, or risky. Never invent facts or commitments.",
        tools: "Email, filesystem, and shell access for coordination tasks. Use available credentials carefully.",
        name: "Avery",
      });
    },
  };
}

function createRealWorkflowClient(): WorkflowClient {
  return {
    async startTaskWorkflow({ taskId, agentId, workflowId, resumeInput }) {
      const client = await getTemporalClient();
      const handle = await client.workflow.start("taskWorkflow", {
        args: [taskId, agentId, resumeInput ?? null],
        taskQueue: TASK_QUEUE,
        workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
      });
      return { firstExecutionRunId: handle.firstExecutionRunId };
    },
    async startScheduleWorkflow({ scheduleId, targetWorkflowId, fireAtMs, message }) {
      const client = await getTemporalClient();
      const handle = await client.workflow.start("scheduleTimerWorkflow", {
        args: [scheduleId, targetWorkflowId, fireAtMs, message],
        taskQueue: TASK_QUEUE,
        workflowId: `schedule-${scheduleId}`,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
      });
      return { firstExecutionRunId: handle.firstExecutionRunId };
    },
    async terminateWorkflow(workflowId, reason) {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowId);
      await handle.terminate(reason);
    },
    async signalWorkflow(workflowId, signalName, ...args) {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowId);
      await handle.signal(signalName, ...args);
    },
    async describeWorkflow(workflowId, runId) {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowId, runId);
      return await handle.describe();
    },
    async queryWorkflow(workflowId, queryName, runId) {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowId, runId);
      return await handle.query(queryName);
    },
  };
}

function createFakeWorkflowClient(): WorkflowClient {
  return {
    async startTaskWorkflow() {
      return { firstExecutionRunId: `fake-run-${crypto.randomUUID()}` };
    },
    async startScheduleWorkflow() {
      return { firstExecutionRunId: `fake-run-${crypto.randomUUID()}` };
    },
    async terminateWorkflow() {
      return;
    },
    async signalWorkflow() {
      return;
    },
    async describeWorkflow() {
      return {};
    },
    async queryWorkflow() {
      return {} as never;
    },
  };
}

export function getWebServiceDependencies(): WebServiceDependencies {
  return {
    db: prisma,
    mail: isFakeMode("MAIL") ? createFakeMailGateway() : createRealMailGateway(),
    llm: isFakeMode("LLM") ? createFakeLlmGateway() : createRealLlmGateway(),
    workflows: isFakeMode("WORKFLOW")
      ? createFakeWorkflowClient()
      : createRealWorkflowClient(),
  };
}
