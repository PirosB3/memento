import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  ensureUniqueSlug,
  generateTaskSlug,
  isSlugUniqueViolation,
  withSlugRetry,
} from "./slug";

describe("generateTaskSlug", () => {
  it("kebab-cases the objective and appends the date", () => {
    const slug = generateTaskSlug("Follow up with Alice", new Date("2026-05-07T12:34:00Z"));
    expect(slug).toBe("follow-up-with-alice-2026-05-07");
  });

  it("falls back to a `task-` prefix when the objective has no alphanumerics", () => {
    expect(generateTaskSlug("---", new Date("2026-05-07T00:00:00Z")))
      .toBe("task-2026-05-07");
  });
});

describe("ensureUniqueSlug", () => {
  it("returns the base slug when it is free", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const slug = await ensureUniqueSlug(
      { task: { findFirst } } as never,
      "agent-1",
      "follow-up-2026-05-07",
    );
    expect(slug).toBe("follow-up-2026-05-07");
  });

  it("appends `-2`, `-3`, … until a free slug is found", async () => {
    const findFirst = vi.fn()
      .mockResolvedValueOnce({ taskId: "t1" })
      .mockResolvedValueOnce({ taskId: "t2" })
      .mockResolvedValueOnce(null);
    const slug = await ensureUniqueSlug(
      { task: { findFirst } } as never,
      "agent-1",
      "follow-up-2026-05-07",
    );
    expect(slug).toBe("follow-up-2026-05-07-3");
  });
});

describe("isSlugUniqueViolation", () => {
  it("is true for P2002 with the slug column in target", () => {
    const err = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["agent_id", "slug"] },
    });
    expect(isSlugUniqueViolation(err)).toBe(true);
  });

  it("is true for P2002 with an index name containing `slug`", () => {
    const err = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: "tasks_agent_id_slug_key" },
    });
    expect(isSlugUniqueViolation(err)).toBe(true);
  });

  it("is false for unrelated Prisma errors", () => {
    const err = new Prisma.PrismaClientKnownRequestError("not found", {
      code: "P2025",
      clientVersion: "test",
    });
    expect(isSlugUniqueViolation(err)).toBe(false);
  });

  it("is false for non-Prisma errors", () => {
    expect(isSlugUniqueViolation(new Error("oops"))).toBe(false);
  });
});

describe("withSlugRetry", () => {
  function slugViolation() {
    return new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["agent_id", "slug"] },
    });
  }

  it("returns the op result on first success", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const next = vi.fn();
    const result = await withSlugRetry(op, "slug-1", next);
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledOnce();
    expect(op).toHaveBeenCalledWith("slug-1");
    expect(next).not.toHaveBeenCalled();
  });

  it("retries with the next slug on a slug unique violation", async () => {
    const op = vi.fn()
      .mockRejectedValueOnce(slugViolation())
      .mockResolvedValueOnce("ok");
    const next = vi.fn().mockResolvedValue("slug-2");

    const result = await withSlugRetry(op, "slug-1", next, 3);

    expect(result).toBe("ok");
    expect(op).toHaveBeenNthCalledWith(1, "slug-1");
    expect(op).toHaveBeenNthCalledWith(2, "slug-2");
    expect(next).toHaveBeenCalledOnce();
  });

  it("rethrows after exhausting the retry limit", async () => {
    const op = vi.fn().mockRejectedValue(slugViolation());
    const next = vi.fn().mockResolvedValue("slug-2");
    await expect(withSlugRetry(op, "slug-1", next, 1)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("does not retry on errors that are not slug violations", async () => {
    const other = new Error("boom");
    const op = vi.fn().mockRejectedValue(other);
    const next = vi.fn();
    await expect(withSlugRetry(op, "slug-1", next, 3)).rejects.toBe(other);
    expect(op).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });
});
