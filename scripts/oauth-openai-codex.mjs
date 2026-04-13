#!/usr/bin/env node
/**
 * OpenAI Codex (ChatGPT subscription) OAuth login.
 *
 * Runs the PKCE OAuth flow against auth.openai.com, captures the callback
 * on http://localhost:1455, and writes credentials to
 * data/openai-codex-credentials.json.
 *
 * Usage:
 *   node scripts/oauth-openai-codex.mjs
 *   pnpm oauth:openai            (if the package.json script is added)
 */
import { loginOpenAICodex } from "../repos/pi-mono/packages/ai/dist/oauth.js";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CREDS_PATH = path.join(REPO_ROOT, "data", "openai-codex-credentials.json");

function openBrowser(url) {
  try {
    const cmd =
      process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
          ? `start "" "${url}"`
          : `xdg-open "${url}"`;
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function promptStdin(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  fs.mkdirSync(path.dirname(CREDS_PATH), { recursive: true });

  if (fs.existsSync(CREDS_PATH)) {
    const answer = await promptStdin(
      `Credentials already exist at ${CREDS_PATH}. Overwrite? [y/N]: `,
    );
    if (answer.toLowerCase() !== "y") {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  console.log("\nStarting OpenAI Codex (ChatGPT) OAuth flow...\n");

  const credentials = await loginOpenAICodex({
    originator: "summon-agents",
    onAuth: ({ url }) => {
      console.log("Open this URL in your browser to sign in:\n");
      console.log(`  ${url}\n`);
      const opened = openBrowser(url);
      if (opened) {
        console.log("(Browser opened automatically. Complete the login and return here.)\n");
      } else {
        console.log("(Copy the URL above into your browser manually.)\n");
      }
    },
    onPrompt: async ({ message }) => {
      return promptStdin(`${message}\n> `);
    },
    onProgress: (msg) => console.log(`[oauth] ${msg}`),
  });

  fs.writeFileSync(CREDS_PATH, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });

  const expiresAt = new Date(credentials.expires).toISOString();
  console.log(`\nOAuth login successful.`);
  console.log(`  Account ID: ${credentials.accountId}`);
  console.log(`  Token expires: ${expiresAt}`);
  console.log(`  Saved to: ${CREDS_PATH}`);
  console.log(`\nThe worker will read this file on startup. Refresh tokens are persisted — the`);
  console.log(`token will be refreshed automatically when it expires.\n`);
}

main().catch((err) => {
  console.error("\nOAuth login failed:", err?.message ?? err);
  process.exit(1);
});
