import { describe, expect, it } from "vitest";
import {
  buildFailClosedScreening,
  validateScreeningDecisions,
  type EmailForScreening,
  type EmailScreenerToolDecision,
} from "./email-screener-validation";

function email(messageId: string): EmailForScreening {
  return {
    messageId,
    sender: "sender@example.com",
    subject: "Question",
    threadId: `thread-${messageId}`,
    to: ["agent@agentmail.test"],
    cc: [],
    timestamp: "2026-05-02T10:00:00.000Z",
    labels: ["received"],
    hasAttachments: false,
    body: "Can you help with scheduling?",
  };
}

describe("email screener decision validation", () => {
  it("accepts one approve decision per expected message", () => {
    const result = validateScreeningDecisions(
      ["msg-1"],
      [{
        messageId: "msg-1",
        disposition: "approve",
        riskLevel: "low",
        categories: ["benign"],
        requestedActions: [],
        reason: "Routine scheduling request.",
      }],
      [email("msg-1")],
    );

    expect(result.approvedMessageIds).toEqual(["msg-1"]);
    expect(result.rejectedMessageIds).toEqual([]);
    expect(result.decisions[0]).toEqual(expect.objectContaining({
      disposition: "approve",
      threadId: "thread-msg-1",
    }));
  });

  it("accepts one reject decision per expected message", () => {
    const result = validateScreeningDecisions(
      ["msg-1"],
      [{
        messageId: "msg-1",
        disposition: "reject",
        riskLevel: "critical",
        categories: ["credential_request", "social_engineering"],
        requestedActions: ["share password"],
        reason: "Requests credentials from a non-owner sender.",
      }],
      [email("msg-1")],
    );

    expect(result.approvedMessageIds).toEqual([]);
    expect(result.rejectedMessageIds).toEqual(["msg-1"]);
  });

  it("rejects duplicate decisions", () => {
    const decisions: EmailScreenerToolDecision[] = [
      {
        messageId: "msg-1",
        disposition: "approve",
        riskLevel: "none",
        categories: ["benign"],
        requestedActions: [],
        reason: "Benign.",
      },
      {
        messageId: "msg-1",
        disposition: "reject",
        riskLevel: "high",
        categories: ["other"],
        requestedActions: [],
        reason: "Duplicate.",
      },
    ];

    expect(() => validateScreeningDecisions(["msg-1"], decisions, [email("msg-1")]))
      .toThrow(/duplicate decisions/);
  });

  it("rejects missing and unknown message ids", () => {
    expect(() => validateScreeningDecisions(["msg-1"], [], [email("msg-1")]))
      .toThrow(/missed messageId/);

    expect(() => validateScreeningDecisions(
      ["msg-1"],
      [{
        messageId: "msg-2",
        disposition: "approve",
        riskLevel: "none",
        categories: ["benign"],
        requestedActions: [],
        reason: "Wrong id.",
      }],
      [email("msg-1")],
    )).toThrow(/unknown messageId/);
  });

  it("rejects invalid categories and accepts other", () => {
    expect(() => validateScreeningDecisions(
      ["msg-1"],
      [{
        messageId: "msg-1",
        disposition: "reject",
        riskLevel: "high",
        categories: ["not_a_category"],
        requestedActions: [],
        reason: "Bad category.",
      } as unknown as EmailScreenerToolDecision],
      [email("msg-1")],
    )).toThrow();

    const result = validateScreeningDecisions(
      ["msg-1"],
      [{
        messageId: "msg-1",
        disposition: "reject",
        riskLevel: "high",
        categories: ["other"],
        requestedActions: [],
        reason: "Unclear but risky.",
      }],
      [email("msg-1")],
    );
    expect(result.rejectedMessageIds).toEqual(["msg-1"]);
  });

  it("builds fail-closed rejections for the whole batch", () => {
    const result = buildFailClosedScreening([email("msg-1"), email("msg-2")]);

    expect(result.approvedMessageIds).toEqual([]);
    expect(result.rejectedMessageIds).toEqual(["msg-1", "msg-2"]);
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.every((decision) => decision.categories.includes("other"))).toBe(true);
  });
});
