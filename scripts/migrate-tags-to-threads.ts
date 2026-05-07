/**
 * One-shot migration: backfill `tasks.slug` and `tasks.agentmail_thread_ids`
 * for legacy child tasks that were created when routing relied on `+tag`
 * recipients. After this script runs, the new threadId-based gateway routing
 * works end-to-end for existing tasks too.
 *
 * Steps for each agent:
 *   1. Paginate the AgentMail inbox.
 *   2. For each AgentMail thread, build the set of bare recipient/sender
 *      addresses involved in any of its messages.
 *   3. For each child task whose `tag` (the task UUID, also the legacy +tag
 *      slug) appears as `<local>+<tag>@<domain>` in any thread's recipients,
 *      record those AgentMail thread IDs against the task.
 *   4. Generate a slug from the task's objective + createdAt and write both
 *      `slug` and `agentmail_thread_ids` to the task row.
 *
 * Tasks without any matching AgentMail threads still get a slug (and an
 * empty thread-id array) so subsequent outbound mail records its threadId
 * via the live `recordTaskThreadId` hook.
 *
 * Run order: dev → test → prod. Use `--dry-run` to inspect without writing.
 *
 *   pnpm tsx scripts/migrate-tags-to-threads.ts [--dry-run]
 *
 * Pause workers before running, then resume after.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import { AgentMailClient } from "agentmail";
import {
  prisma,
  createLogger,
  generateTaskSlug,
  ensureUniqueSlug,
} from "@summon/shared";

const log = createLogger("migrate-tags-to-threads");
const PAGE_SIZE = 100;
const DRY_RUN = process.argv.includes("--dry-run");

function extractBareAddress(raw: string | undefined | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/<([^>]+)>/);
  return (match?.[1] ?? trimmed).trim().toLowerCase();
}

function coerceList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return [raw];
  return [];
}

interface ThreadAddressIndex {
  threadAddresses: Map<string, Set<string>>;
}

async function buildThreadAddressIndex(
  agentmail: AgentMailClient,
  inboxId: string,
): Promise<ThreadAddressIndex> {
  const threadAddresses = new Map<string, Set<string>>();
  let pageToken: string | undefined;

  while (true) {
    const params: Record<string, unknown> = { limit: PAGE_SIZE, includeSpam: true };
    if (pageToken) params.pageToken = pageToken;
    const response = (await agentmail.inboxes.messages.list(inboxId, params)) as Record<string, unknown>;
    const messages = (response.messages ?? response.data ?? []) as Record<string, unknown>[];
    if (!Array.isArray(messages) || messages.length === 0) break;

    for (const msg of messages) {
      const threadId = (msg.threadId ?? msg.thread_id) as string | undefined;
      if (!threadId) continue;
      const addresses = threadAddresses.get(threadId) ?? new Set<string>();
      for (const raw of [
        msg.from as string | undefined,
        ...coerceList(msg.to),
        ...coerceList(msg.cc),
      ]) {
        const bare = extractBareAddress(raw);
        if (bare) addresses.add(bare);
      }
      threadAddresses.set(threadId, addresses);
    }

    const next = (response.nextPageToken ?? response.next_page_token) as string | undefined;
    if (!next) break;
    pageToken = next;
  }

  return { threadAddresses };
}

async function migrateAgent(
  agentmail: AgentMailClient,
  agent: { agentId: string; agentEmail: string },
): Promise<void> {
  log.info(`[${agent.agentId}] Indexing AgentMail threads in ${agent.agentEmail}...`);
  const { threadAddresses } = await buildThreadAddressIndex(agentmail, agent.agentEmail);
  log.info(`[${agent.agentId}] Indexed ${threadAddresses.size} AgentMail thread(s)`);

  const [local, domain] = agent.agentEmail.toLowerCase().split("@");

  const tasks = await prisma.task.findMany({
    where: { agentId: agent.agentId, isRoot: false },
    orderBy: { createdAt: "asc" },
  });

  for (const task of tasks) {
    const expectedTagAddress = `${local}+${task.tag}@${domain}`;
    const matchedThreadIds: string[] = [];
    for (const [threadId, addresses] of threadAddresses) {
      if (addresses.has(expectedTagAddress)) matchedThreadIds.push(threadId);
    }

    let slug = task.slug;
    if (!slug) {
      slug = await ensureUniqueSlug(prisma, agent.agentId, generateTaskSlug(task.objective, task.createdAt));
    }

    const existingIds = new Set(task.agentmailThreadIds ?? []);
    for (const id of matchedThreadIds) existingIds.add(id);
    const finalIds = [...existingIds];

    log.info(
      `[${agent.agentId}] task=${task.taskId} tag=${task.tag} slug=${slug} `
        + `legacy_match=${matchedThreadIds.length} final_threads=${finalIds.length}`,
    );

    if (DRY_RUN) continue;

    await prisma.task.update({
      where: { taskId: task.taskId },
      data: { slug, agentmailThreadIds: finalIds },
    });
  }
}

async function main(): Promise<void> {
  log.info(`Starting tag→thread migration${DRY_RUN ? " (DRY RUN)" : ""}`);

  const agentmail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
  const agents = await prisma.agent.findMany({
    where: { status: { in: ["IDLE", "RUNNING"] } },
  });

  if (agents.length === 0) {
    log.info("No agents to migrate.");
    return;
  }

  for (const agent of agents) {
    try {
      await migrateAgent(agentmail, agent);
    } catch (err) {
      log.error(`Failed to migrate agent ${agent.agentId}:`, err);
    }
  }

  log.info(`Migration ${DRY_RUN ? "(dry run) " : ""}complete.`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    log.error("Migration failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
