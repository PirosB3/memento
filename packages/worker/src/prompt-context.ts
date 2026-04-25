import type { Agent, Task } from "@prisma/client";
import type { WakeSource } from "@summon/shared";

export interface WakeMetadataItem {
  label: string;
  value: string;
}

export interface BuildWakeMessageInput {
  wokenBy: WakeSource;
  priorState: string;
  lastStopReason?: string | null;
  triggerContext: string;
  metadata?: WakeMetadataItem[];
  reflection: string;
  todoSnapshot?: string;
  actionNow: string;
  configChanged: boolean;
  configChangedFields?: string[];
  configSnapshot?: {
    soul: string;
    boundaries: string;
    tools: string;
  };
}

function taskEmailFor(agent: Agent, task: Task): string {
  if (task.isRoot) {
    return agent.agentEmail;
  }

  const [localPart, domain] = agent.agentEmail.split("@");
  return `${localPart}+${task.tag}@${domain}`;
}

export function buildContextSeedMessage(agent: Agent, task: Task): string {
  return `## CONTEXT SEED
Treat this message as stable reference context for the task. It is not a new request.

ROLE: ${task.isRoot ? "root" : "child"}
AGENT NAME: ${agent.name}
OWNER EMAIL: ${agent.ownerEmail}
TASK EMAIL: ${taskEmailFor(agent, task)}

## OBJECTIVE
${task.objective}

## CONFIG SNAPSHOT
### SOUL
${agent.soul}

### BOUNDARIES
${agent.boundaries}

### TOOLS
${agent.tools}`;
}

export function buildWakeMessage(input: BuildWakeMessageInput): string {
  const metadataLines = (input.metadata ?? [])
    .map((item) => `- ${item.label}: ${item.value}`)
    .join("\n");
  const configSection = input.configChanged && input.configSnapshot
    ? `\n### UPDATED CONFIG SNAPSHOT
#### SOUL
${input.configSnapshot.soul}

#### BOUNDARIES
${input.configSnapshot.boundaries}

#### TOOLS
${input.configSnapshot.tools}`
    : "";
  const whatChangedSection = input.configChanged
    ? `\n\n## WHAT CHANGED
- Changed fields: ${input.configChangedFields?.length ? input.configChangedFields.join(", ") : "unknown"}${configSection}`
    : "";
  const todoSection = input.todoSnapshot
    ? `\n\n## TODO SNAPSHOT
${input.todoSnapshot}`
    : "";

  return `## WAKE
WOKEN BY: ${input.wokenBy}
PRIOR STATE: ${input.priorState}
LAST STOP REASON: ${input.lastStopReason ?? "none"}

## TRIGGER CONTEXT
${input.triggerContext}

## TRIGGER METADATA
${metadataLines || "- none"}${whatChangedSection}

## WAKE REFLECTION
${input.reflection}${todoSection}

## ACTION NOW
${input.actionNow}`;
}
