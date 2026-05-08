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
