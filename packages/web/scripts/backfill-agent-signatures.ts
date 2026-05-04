import OpenAI from "openai";
import { prisma } from "@summon/shared";
import {
  buildAvatarPrompt,
  createRealAvatarGenerator,
} from "../src/lib/server/avatar-generation";

const APPLY = process.argv.includes("--apply");
const FORCE_PFP = process.argv.includes("--force-pfp");
const FORCE_ROLE = process.argv.includes("--force-role");

function parseSkipFlag(): Set<string> {
  const idx = process.argv.indexOf("--skip");
  if (idx === -1 || !process.argv[idx + 1]) return new Set();
  return new Set(
    process.argv[idx + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const SKIP_AGENT_IDS = parseSkipFlag();

const DESCRIPTION_SYSTEM = `You write short job titles for AI agents that appear in their email signature. Given the agent's name and SOUL (personality/voice), output a concise role title of 2 to 4 words that captures their function. Examples: "Personal Assistant", "Recruiting Coordinator", "Bookkeeper", "Household Manager". Use title case. Output the title only — no quotes, no preface, no trailing punctuation.`;

async function generateDescription(name: string, soul: string): Promise<string> {
  const openai = new OpenAI();
  const res = await openai.chat.completions.create({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: DESCRIPTION_SYSTEM },
      { role: "user", content: `Name: ${name}\n\nSOUL:\n${soul}` },
    ],
  });
  const text = res.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned empty content");
  return text.replace(/^["']|["']$/g, "");
}

async function main() {
  const agents = await prisma.agent.findMany({
    select: {
      agentId: true,
      name: true,
      soul: true,
      signatureDisplayName: true,
      signatureDescription: true,
      profileImageUrl: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const candidates = agents.filter((a) => {
    if (SKIP_AGENT_IDS.has(a.agentId)) return false;
    if (FORCE_PFP || FORCE_ROLE) return true;
    return !a.signatureDisplayName || !a.signatureDescription || !a.profileImageUrl;
  });

  const flagLabel = [FORCE_PFP && "force-pfp", FORCE_ROLE && "force-role"].filter(Boolean).join(",");
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}${flagLabel ? ` (${flagLabel})` : ""}`);
  console.log(`Total agents: ${agents.length}`);
  console.log(`Skipped: ${agents.filter((a) => SKIP_AGENT_IDS.has(a.agentId)).map((a) => a.agentId).join(", ") || "(none)"}`);
  console.log(`Candidates: ${candidates.length}`);
  for (const a of candidates) {
    const work = [
      a.signatureDisplayName ? null : "displayName",
      FORCE_ROLE ? "role(force)" : a.signatureDescription ? null : "role",
      FORCE_PFP ? "pfp(force)" : a.profileImageUrl ? null : "pfp",
    ].filter(Boolean);
    console.log(`  - ${a.agentId.padEnd(20)} ${a.name.padEnd(14)} will do: ${work.join(", ")}`);
  }

  if (!APPLY) {
    console.log("\nDry-run only. Rerun with `--apply` to execute.");
    await prisma.$disconnect();
    return;
  }

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  if (!process.env.R2_ACCOUNT_ID) throw new Error("R2_ACCOUNT_ID not set");

  const avatars = createRealAvatarGenerator();

  let ok = 0;
  let failed = 0;
  for (const a of candidates) {
    console.log(`\n→ ${a.agentId} (${a.name})`);
    const update: {
      signatureDisplayName?: string;
      signatureDescription?: string;
      profileImageUrl?: string;
    } = {};

    try {
      if (!a.signatureDisplayName) {
        update.signatureDisplayName = a.name;
        console.log(`  displayName: ${a.name}`);
      }
      if (!a.signatureDescription || FORCE_ROLE) {
        const desc = await generateDescription(a.name, a.soul);
        update.signatureDescription = desc;
        console.log(`  role:        ${desc}`);
      }
      if (!a.profileImageUrl || FORCE_PFP) {
        const prompt = await buildAvatarPrompt(a.name, a.soul);
        const url = await avatars.generateAndUploadAvatar({
          agentId: a.agentId,
          prompt,
        });
        update.profileImageUrl = url;
        console.log(`  pfp:         ${url}`);
      }
      await prisma.agent.update({ where: { agentId: a.agentId }, data: update });
      console.log(`  ✓ updated`);
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ failed: ${msg}`);
      failed += 1;
    }
  }

  console.log(`\nDone. Succeeded: ${ok}, Failed: ${failed}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
