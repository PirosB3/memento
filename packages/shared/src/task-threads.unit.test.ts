import { describe, expect, it, vi } from "vitest";
import {
  AgentMailThreadBindingConflictError,
  findTaskByAgentmailThreadId,
  recordTaskThreadId,
} from "./task-threads";

function buildDb(existing: { taskId: string } | null = null) {
  return {
    agentMailThreadBinding: {
      findUnique: vi.fn().mockResolvedValue(existing),
      findFirst: vi.fn().mockResolvedValue(existing),
      create: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("task thread bindings", () => {
  it("creates a bridge binding for a new AgentMail thread", async () => {
    const db = buildDb();

    await recordTaskThreadId(db as never, {
      taskId: "task-1",
      agentmailThreadId: "thread-1",
    });

    expect(db.agentMailThreadBinding.create).toHaveBeenCalledWith({
      data: {
        taskId: "task-1",
        agentmailThreadId: "thread-1",
      },
    });
  });

  it("is idempotent when the thread is already bound to the same task", async () => {
    const db = buildDb({ taskId: "task-1" });

    await recordTaskThreadId(db as never, {
      taskId: "task-1",
      agentmailThreadId: "thread-1",
    });

    expect(db.agentMailThreadBinding.create).not.toHaveBeenCalled();
  });

  it("rejects binding the same AgentMail thread to another task", async () => {
    const db = buildDb({ taskId: "task-existing" });

    await expect(recordTaskThreadId(db as never, {
      taskId: "task-requested",
      agentmailThreadId: "thread-1",
    })).rejects.toBeInstanceOf(AgentMailThreadBindingConflictError);
  });

  it("looks up task ownership by agent and AgentMail thread", async () => {
    const db = buildDb({ taskId: "task-1" });

    const result = await findTaskByAgentmailThreadId(db as never, {
      agentId: "agent-1",
      agentmailThreadId: "thread-1",
    });

    expect(result).toEqual({ taskId: "task-1" });
    expect(db.agentMailThreadBinding.findFirst).toHaveBeenCalledWith({
      where: {
        agentmailThreadId: "thread-1",
        task: { agentId: "agent-1" },
      },
      select: { taskId: true },
    });
  });
});
