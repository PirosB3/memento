export function extractAgentMailThreadId(msg: Record<string, unknown>): string | null {
  const threadId = msg.threadId ?? msg.thread_id;
  return typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
}

export function coerceAgentMailAddressList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return [raw];
  return [];
}

export function extractBareEmailAddress(raw: string | undefined | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/<([^>]+)>/);
  return (match?.[1] ?? trimmed).trim().toLowerCase();
}

/** True when `fromField` is the agent's base inbox or a tagged variant (local+tag@domain). */
export function isAgentSelfEmail(fromField: string, agentEmail: string): boolean {
  const from = extractBareEmailAddress(fromField);
  if (!from) return false;

  const [local, domain] = agentEmail.toLowerCase().split("@");
  if (!local || !domain) return false;

  const base = `${local}@${domain}`;
  if (from === base) return true;

  const taggedPrefix = `${local}+`;
  const taggedSuffix = `@${domain}`;
  return from.startsWith(taggedPrefix) && from.endsWith(taggedSuffix);
}
