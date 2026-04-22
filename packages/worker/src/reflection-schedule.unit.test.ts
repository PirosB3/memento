import { describe, expect, it } from "vitest";
import {
  nextReflectionDueAt,
  normalizeReflectionTimestamp,
  reflectionIsDue,
  timeUntilNextReflection,
} from "./reflection-schedule";

describe("reflection schedule", () => {
  it("waits until 03:00 local before the first nightly reflection", () => {
    const now = new Date(2026, 3, 22, 1, 15, 0, 0);
    const dueAt = nextReflectionDueAt(now, null);

    expect(dueAt.getTime()).toBe(new Date(2026, 3, 22, 3, 0, 0, 0).getTime());
    expect(reflectionIsDue(now, null)).toBe(false);
  });

  it("treats reflection as immediately due after 03:00 local when none ran yet", () => {
    const now = new Date(2026, 3, 22, 4, 30, 0, 0);

    expect(nextReflectionDueAt(now, null).getTime()).toBe(now.getTime());
    expect(timeUntilNextReflection(now, null)).toBe(0);
    expect(reflectionIsDue(now, null)).toBe(true);
  });

  it("defers until tomorrow once today's reflection already ran", () => {
    const now = new Date(2026, 3, 22, 10, 0, 0, 0);
    const lastReflectionAt = new Date(2026, 3, 22, 4, 45, 0, 0).toISOString();
    const dueAt = nextReflectionDueAt(now, lastReflectionAt);

    expect(dueAt.getTime()).toBe(new Date(2026, 3, 23, 3, 0, 0, 0).getTime());
    expect(reflectionIsDue(now, lastReflectionAt)).toBe(false);
  });

  it("drops invalid persisted timestamps instead of crashing", () => {
    const now = new Date(2026, 3, 22, 4, 0, 0, 0);

    expect(normalizeReflectionTimestamp("not-a-date")).toBeNull();
    expect(timeUntilNextReflection(now, "not-a-date")).toBe(0);
  });
});
