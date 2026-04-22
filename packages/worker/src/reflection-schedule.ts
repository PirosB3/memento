const DAY_MS = 24 * 60 * 60 * 1000;

export const REFLECTION_HOUR_LOCAL = 3;

function parseReflectionTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeReflectionTimestamp(value: string | null | undefined): string | null {
  return parseReflectionTimestamp(value)?.toISOString() ?? null;
}

export function nextReflectionDueAt(now: Date, lastReflectionAt: string | null): Date {
  const todayReflection = new Date(now);
  todayReflection.setHours(REFLECTION_HOUR_LOCAL, 0, 0, 0);

  const lastReflection = parseReflectionTimestamp(lastReflectionAt);
  if (!lastReflection) {
    return now.getTime() < todayReflection.getTime() ? todayReflection : now;
  }

  if (lastReflection.getTime() >= todayReflection.getTime()) {
    return new Date(todayReflection.getTime() + DAY_MS);
  }

  return now.getTime() < todayReflection.getTime() ? todayReflection : now;
}

export function timeUntilNextReflection(now: Date, lastReflectionAt: string | null): number {
  return Math.max(0, nextReflectionDueAt(now, lastReflectionAt).getTime() - now.getTime());
}

export function reflectionIsDue(now: Date, lastReflectionAt: string | null): boolean {
  return timeUntilNextReflection(now, lastReflectionAt) === 0;
}
