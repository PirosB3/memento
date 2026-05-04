import type { Agent, Task } from "@prisma/client";
import type { WakeChannel, WakeSource } from "@summon/shared";

export interface WakeMetadataItem {
  label: string;
  value: string;
}

export interface BuildWakeMessageInput {
  wokenBy: WakeSource;
  channel: WakeChannel;
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

function describeChannelReplyRule(channel: WakeChannel): string {
  switch (channel) {
    case "email":
      return "Reply on the email thread that woke you (use reply_email / send_email). Do not respond only via in-conversation text.";
    case "ui":
      return "The owner is watching this conversation in the dashboard. Your assistant text in this turn IS the reply — do NOT send an email back to the owner about this wake.";
    case "scheduler":
      return "Scheduler wake — there is no inbound message to reply to. Act on the reminder; only email if the action itself requires it.";
    case "system":
      return "System wake (created / restart / sleep timeout) — there is no inbound message to reply to. Continue the task and only email if the action itself requires it.";
  }
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
WAKE CHANNEL: ${input.channel}
PRIOR STATE: ${input.priorState}
LAST STOP REASON: ${input.lastStopReason ?? "none"}

## REPLY CHANNEL RULE
${describeChannelReplyRule(input.channel)}

## TRIGGER CONTEXT
${input.triggerContext}

## TRIGGER METADATA
${metadataLines || "- none"}${whatChangedSection}

## WAKE REFLECTION
${input.reflection}${todoSection}

## ACTION NOW
${input.actionNow}`;
}
