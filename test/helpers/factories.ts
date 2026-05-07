export function buildAgentRecord(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-1",
    name: "Avery",
    agentEmail: "avery@agentmail.test",
    ownerEmail: "owner@example.com",
    soul: "Helpful and clear.",
    boundaries: "Escalate risky work.",
    tools: "Email and filesystem.",
    signatureDisplayName: null,
    signatureDescription: null,
    profileImageUrl: null,
    status: "IDLE",
    temporalRunId: "run-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

export function buildTaskRecord(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    agentId: "agent-1",
    tag: "root-agent-1",
    slug: null,
    _count: { agentmailThreadBindings: 0 },
    objective: "Main thread",
    status: "RUNNING",
    isRoot: true,
    parentTaskId: null,
    temporalRunId: "run-1",
    maxTurns: 20,
    timeoutHours: 72,
    lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: null,
    compactedSummary: null,
    compactedPrefix: null,
    compactedThroughId: null,
    ...overrides,
  };
}
