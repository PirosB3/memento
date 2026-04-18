import { describe, expect, it, vi } from "vitest";
import { createMockWebDeps } from "../../../../../test/helpers/web-deps";
import { buildAgentRecord } from "../../../../../test/helpers/factories";
import {
  createAgent,
  generateAgentConfig,
  prepareAgent,
} from "./agent-services";

describe("agent services", () => {
  it("parses clarifying questions from wrapped model output", async () => {
    const llm = {
      createText: vi.fn().mockResolvedValue('Here you go: ["Question 1","Question 2"]'),
    };
    const deps = createMockWebDeps({ llm });

    const result = await prepareAgent(
      {
        objective: "Help me coordinate my inbox",
        ownerEmail: "owner@example.com",
      },
      deps,
    );

    expect(result.questions).toEqual(["Question 1", "Question 2"]);
    expect(llm.createText).toHaveBeenCalledOnce();
  });

  it("parses generated config from wrapped JSON output", async () => {
    const llm = {
      createText: vi.fn().mockResolvedValue(
        'Result: {"name":"Avery","soul":"Warm","boundaries":"Escalate risky work","tools":"Email","signatureDescription":"Your friendly inbox co-pilot."}',
      ),
    };
    const deps = createMockWebDeps({ llm });

    const result = await generateAgentConfig(
      {
        objective: "Coordinate people",
        ownerEmail: "owner@example.com",
        answers: {
          Tone: "Warm",
        },
      },
      deps,
    );

    expect(result).toEqual({
      name: "Avery",
      soul: "Warm",
      boundaries: "Escalate risky work",
      tools: "Email",
      signatureDescription: "Your friendly inbox co-pilot.",
    });
  });

  it("retries inbox creation conflicts and stores failed-to-start when workflow boot fails", async () => {
    const mail = {
      createInbox: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("Conflict"), { body: { name: "IsTakenError" } }))
        .mockResolvedValueOnce({ email: "avery-2@agentmail.test" }),
    };
    const workflows = {
      startTaskWorkflow: vi.fn().mockRejectedValue(new Error("Temporal unavailable")),
      terminateWorkflow: vi.fn(),
    };
    const avatars = {
      generateAndUploadAvatar: vi
        .fn()
        .mockResolvedValue("https://pub-example.test/pfps/avery-2.png"),
    };
    const deps = createMockWebDeps({ mail, workflows, avatars });
    const db = deps.db as unknown as {
      agent: { create: ReturnType<typeof vi.fn> };
      task: { create: ReturnType<typeof vi.fn> };
    };

    db.agent.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      buildAgentRecord(data),
    );
    db.task.create.mockResolvedValue(undefined);

    const result = await createAgent(
      {
        ownerEmail: "owner@example.com",
        name: "Avery",
        soul: "Warm",
        boundaries: "Escalate risky work",
        tools: "Email",
        signatureDescription: "Your friendly inbox co-pilot.",
      },
      deps,
    );

    expect(mail.createInbox).toHaveBeenCalledTimes(2);
    expect(workflows.startTaskWorkflow).toHaveBeenCalledOnce();
    expect(avatars.generateAndUploadAvatar).toHaveBeenCalledOnce();
    expect(db.agent.create.mock.calls[0][0].data.temporalRunId).toBe("failed-to-start");
    expect(db.agent.create.mock.calls[0][0].data.profileImageUrl).toBe(
      "https://pub-example.test/pfps/avery-2.png",
    );
    expect(db.agent.create.mock.calls[0][0].data.signatureDisplayName).toBe("Avery");
    expect(db.agent.create.mock.calls[0][0].data.signatureDescription).toBe(
      "Your friendly inbox co-pilot.",
    );
    expect(db.task.create.mock.calls[0][0].data.tag).toMatch(/^root-/);
    expect(result.agentEmail).toBe("avery-2@agentmail.test");
  });

  it("continues when avatar generation fails", async () => {
    const mail = { createInbox: vi.fn().mockResolvedValue({ email: "avery@agentmail.test" }) };
    const workflows = { startTaskWorkflow: vi.fn().mockResolvedValue({ firstExecutionRunId: "run-1" }) };
    const avatars = {
      generateAndUploadAvatar: vi.fn().mockRejectedValue(new Error("openai exploded")),
    };
    const deps = createMockWebDeps({ mail, workflows, avatars });
    const db = deps.db as unknown as {
      agent: { create: ReturnType<typeof vi.fn> };
      task: { create: ReturnType<typeof vi.fn> };
    };
    db.agent.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      buildAgentRecord(data),
    );
    db.task.create.mockResolvedValue(undefined);

    await createAgent(
      {
        ownerEmail: "owner@example.com",
        name: "Avery",
        soul: "Warm",
        boundaries: "Escalate risky work",
        tools: "Email",
      },
      deps,
    );

    expect(avatars.generateAndUploadAvatar).toHaveBeenCalledOnce();
    expect(db.agent.create.mock.calls[0][0].data.profileImageUrl).toBeNull();
  });
});
