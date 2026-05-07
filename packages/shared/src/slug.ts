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
 * given agent. Caller is responsible for racing — Postgres' unique index on
 * `(agent_id, slug)` is the final authority.
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
