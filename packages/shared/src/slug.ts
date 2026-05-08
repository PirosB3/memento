import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

/**
 * Build a stable, kebab-case, alphanumeric slug from a task objective and
 * created-at date. The result is suitable as a per-agent unique handle that
 * appears in outbound `ref:` footers and in the `tasks.slug` column.
 *
 * Format: `<kebab-case-objective-prefix>-YYYY-MM-DD`. The objective prefix is
 * truncated to 50 characters and stripped of anything outside `[a-z0-9-]`.
 * The date suffix gives operators a recency hint at a glance and reduces
 * collisions when the same objective phrasing repeats.
 */
export function generateTaskSlug(objective: string, createdAt: Date): string {
  const datePart = createdAt.toISOString().slice(0, 10); // YYYY-MM-DD

  const base = objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");

  return base ? `${base}-${datePart}` : `task-${datePart}`;
}

interface PrismaSlugLookup {
  task: { findFirst(args: { where: { agentId: string; slug: string }; select: { taskId: true } }): Promise<{ taskId: string } | null> };
}

/**
 * Append `-2`, `-3`, ... to `baseSlug` until we find one that's free for the
 * given agent. The Postgres unique index on `(agent_id, slug)` is still the
 * final authority — pair this with `withSlugRetry` when you also want
 * concurrent task creation to be safe.
 */
export async function ensureUniqueSlug(
  prisma: PrismaClient | PrismaSlugLookup,
  agentId: string,
  baseSlug: string,
): Promise<string> {
  let candidate = baseSlug;
  let suffix = 2;
  while (true) {
    const existing = await (prisma as PrismaSlugLookup).task.findFirst({
      where: { agentId, slug: candidate },
      select: { taskId: true },
    });
    if (!existing) return candidate;
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

/**
 * True when the error is a Prisma unique-violation on the per-agent slug index
 * (either the column list `[agent_id, slug]` or the index name
 * `tasks_agent_id_slug_key`, depending on Prisma version).
 */
export function isSlugUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== "P2002") return false;
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.includes("slug");
  if (typeof target === "string") return target.includes("slug");
  return false;
}

const DEFAULT_SLUG_RETRY_LIMIT = 5;

/**
 * Retry `op` when it loses the `(agent_id, slug)` unique race, calling
 * `nextSlug` between attempts to produce a fresh candidate. Used by both task
 * creation paths (web `createTask` and root's `spawn_task` tool) so concurrent
 * task creation surfaces a fresh slug instead of a P2002 to the caller.
 */
export async function withSlugRetry<T>(
  op: (slug: string) => Promise<T>,
  initialSlug: string,
  nextSlug: () => Promise<string>,
  limit = DEFAULT_SLUG_RETRY_LIMIT,
): Promise<T> {
  let slug = initialSlug;
  for (let attempt = 0; attempt <= limit; attempt += 1) {
    try {
      return await op(slug);
    } catch (err) {
      if (attempt === limit || !isSlugUniqueViolation(err)) throw err;
      slug = await nextSlug();
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error("withSlugRetry exhausted without resolution");
}
