import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { AgentMailClient } from "agentmail";
import { prisma, createLogger } from "@summon/shared";
import { collectOutboundRecipients } from "./index.js";

const log = createLogger("email-gateway:backfill");
const PAGE_SIZE = 100;

/**
 * One-shot backfill: for each live agent, paginate every message in the
 * AgentMail inbox, pull out outbound messages (labels include "sent" or from
 * is self), extract their to/cc recipients, and upsert them into
 * `email_contacts`. This seeds the "emails I replied to" set so the spam
 * post-filter in the live gateway can recognize existing correspondents from
 * day one without waiting for new outbound traffic.
 *
 * Idempotent — safe to rerun (unique constraint on (inbox_id, email_address)
 * + `skipDuplicates: true` on createMany).
 *
 * Run with:
 *   pnpm --filter @summon/email-gateway exec tsx src/backfill-contacts.ts
 */
async function main() {
  log.info("Starting email_contacts backfill...");

  const agentmail = new AgentMailClient({
    apiKey: process.env.AGENTMAIL_API_KEY!,
  });

  const agents = await prisma.agent.findMany({
    where: { status: { in: ["IDLE", "RUNNING"] } },
  });

  if (agents.length === 0) {
    log.warn("No live agents found; nothing to backfill.");
    return;
  }

  let totalInserted = 0;

  for (const agent of agents) {
    log.info(`[${agent.agentId}] inbox=${agent.agentEmail}: scanning...`);

    const contacts = new Set<string>();
    let pageToken: string | undefined = undefined;
    let pageCount = 0;
    let sentMessages = 0;

    while (true) {
      pageCount++;
      let page: Record<string, unknown>;
      try {
        page = await agentmail.inboxes.messages.list(agent.agentEmail, {
          limit: PAGE_SIZE,
          pageToken,
          includeSpam: true,
        }) as unknown as Record<string, unknown>;
      } catch (err) {
        log.error(`[${agent.agentId}] page ${pageCount} fetch failed:`, err);
        break;
      }

      const messages = (page.messages ?? page.data ?? []) as Record<string, unknown>[];
      if (!Array.isArray(messages) || messages.length === 0) break;

      for (const msg of messages) {
        const labels = (msg.labels as string[] | undefined) ?? [];
        const from = (msg.from as string) ?? "";
        if (labels.includes("sent") || from.toLowerCase().includes(agent.agentEmail.split("@")[0].toLowerCase() + "@")) {
          sentMessages++;
        }
        collectOutboundRecipients(msg, agent.agentEmail, contacts);
      }

      const nextToken = (page.next_page_token ?? page.nextPageToken) as string | undefined;
      if (!nextToken) break;
      pageToken = nextToken;
    }

    if (contacts.size === 0) {
      log.info(`[${agent.agentId}] sentMessages=${sentMessages} contacts=0 (nothing to insert)`);
      continue;
    }

    const result = await prisma.emailContact.createMany({
      data: [...contacts].map((emailAddress) => ({
        inboxId: agent.agentEmail,
        emailAddress,
      })),
      skipDuplicates: true,
    });

    totalInserted += result.count;
    log.info(`[${agent.agentId}] sentMessages=${sentMessages} uniqueContacts=${contacts.size} inserted=${result.count}`);
  }

  log.info(`Backfill complete. Total rows inserted across all inboxes: ${totalInserted}`);
}

main()
  .catch((err) => {
    log.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
