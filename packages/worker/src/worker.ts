import dotenv from "dotenv";
import { resolve } from "path";
// Worker runs from packages/worker/, so go up 2 levels to repo root
dotenv.config({ path: resolve(process.cwd(), "../../.env") });

import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import * as activities from "./activities.js";
import { TASK_QUEUE, createLogger } from "@summon/shared";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("worker");

async function main() {
  log.info("ENV loaded", {
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hasAgentMailKey: !!process.env.AGENTMAIL_API_KEY,
  });

  log.info("Bundling workflow code...");

  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: path.resolve(__dirname, "./workflows.ts"),
  });

  log.info("Starting Temporal worker...");

  const worker = await Worker.create({
    workflowBundle,
    activities,
    taskQueue: TASK_QUEUE,
  });

  log.info(`Worker started on task queue: ${TASK_QUEUE}`);
  await worker.run();
}

main().catch((err) => {
  log.error("Worker failed", err);
  process.exit(1);
});
