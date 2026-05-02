import { z } from "zod";

export const EMAIL_SCREENING_CATEGORIES = [
  "credential_request",
  "installation_request",
  "social_engineering",
  "coercion",
  "prompt_injection",
  "owner_impersonation",
  "data_exfiltration",
  "financial_or_legal",
  "attachment_or_link_risk",
  "benign",
  "other",
] as const;

const riskLevelSchema = z.enum(["none", "low", "medium", "high", "critical"]);
const categorySchema = z.enum(EMAIL_SCREENING_CATEGORIES);

const toolDecisionSchema = z.object({
  messageId: z.string().min(1),
  riskLevel: riskLevelSchema,
  categories: z.array(categorySchema).min(1),
  requestedActions: z.array(z.string()).default([]),
  reason: z.string().min(1).max(600),
});

export type EmailScreenerToolDecision = z.infer<typeof toolDecisionSchema> & {
  disposition: EmailScreeningDisposition;
};

export type EmailScreeningRiskLevel = z.infer<typeof riskLevelSchema>;
export type EmailScreeningDisposition = "approve" | "reject";
export type EmailScreeningCategory = (typeof EMAIL_SCREENING_CATEGORIES)[number];

export interface EmailForScreening {
  messageId: string;
  sender: string;
  subject: string | null;
  threadId: string | null;
  to: string[];
  cc: string[];
  timestamp: string;
  labels: string[];
  hasAttachments: boolean;
  body: string;
}

export interface ScreenedEmailDecision {
  messageId: string;
  sender: string;
  subject: string | null;
  threadId: string | null;
  riskLevel: EmailScreeningRiskLevel;
  disposition: EmailScreeningDisposition;
  categories: EmailScreeningCategory[];
  requestedActions: string[];
  reason: string;
}

export interface ScreenInboundEmailBatchResult {
  approvedMessageIds: string[];
  rejectedMessageIds: string[];
  decisions: ScreenedEmailDecision[];
  summary: string;
}

export function buildFailClosedScreening(
  emails: EmailForScreening[],
  reason: string,
): ScreenInboundEmailBatchResult {
  const sanitizedReason = sanitizeReason(reason);
  const decisions = emails.map((email): ScreenedEmailDecision => ({
    messageId: email.messageId,
    sender: email.sender,
    subject: email.subject,
    threadId: email.threadId,
    riskLevel: "high",
    disposition: "reject",
    categories: ["other"],
    requestedActions: [],
    reason: sanitizedReason,
  }));

  return {
    approvedMessageIds: [],
    rejectedMessageIds: decisions.map((decision) => decision.messageId),
    decisions,
    summary: buildScreeningSummary(decisions),
  };
}

export function validateScreeningDecisions(
  expectedMessageIds: string[],
  rawDecisions: EmailScreenerToolDecision[],
  emails: EmailForScreening[],
): ScreenInboundEmailBatchResult {
  const expected = new Set(expectedMessageIds);
  const seen = new Set<string>();
  const byMessageId = new Map(emails.map((email) => [email.messageId, email]));
  const decisions: ScreenedEmailDecision[] = [];

  for (const rawDecision of rawDecisions) {
    const parsed = toolDecisionSchema.parse(rawDecision);
    if (!expected.has(parsed.messageId)) {
      throw new Error(`Screener decided unknown messageId: ${parsed.messageId}`);
    }
    if (seen.has(parsed.messageId)) {
      throw new Error(`Screener made duplicate decisions for messageId: ${parsed.messageId}`);
    }
    seen.add(parsed.messageId);

    const email = byMessageId.get(parsed.messageId);
    decisions.push({
      messageId: parsed.messageId,
      sender: email?.sender ?? "",
      subject: email?.subject ?? null,
      threadId: email?.threadId ?? null,
      riskLevel: parsed.riskLevel,
      disposition: rawDecision.disposition,
      categories: parsed.categories,
      requestedActions: parsed.requestedActions,
      reason: sanitizeReason(parsed.reason),
    });
  }

  const missing = expectedMessageIds.filter((messageId) => !seen.has(messageId));
  if (missing.length > 0) {
    throw new Error(`Screener missed messageId(s): ${missing.join(", ")}`);
  }

  return {
    approvedMessageIds: decisions
      .filter((decision) => decision.disposition === "approve")
      .map((decision) => decision.messageId),
    rejectedMessageIds: decisions
      .filter((decision) => decision.disposition === "reject")
      .map((decision) => decision.messageId),
    decisions,
    summary: buildScreeningSummary(decisions),
  };
}

export function sanitizeReason(reason: string): string {
  return reason
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600) || "Email rejected because screening did not produce a safe decision.";
}

export function buildScreeningSummary(decisions: ScreenedEmailDecision[]): string {
  if (decisions.length === 0) return "No emails screened.";
  const approved = decisions.filter((decision) => decision.disposition === "approve").length;
  const rejected = decisions.length - approved;
  const lines = decisions.map((decision) =>
    `${decision.messageId}: ${decision.disposition} risk=${decision.riskLevel} categories=${decision.categories.join(", ")} reason=${decision.reason}`,
  );
  return `Email screening completed: ${approved} approved, ${rejected} rejected.\n${lines.join("\n")}`;
}
