import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const defaultDbPath = path.resolve(packageDir, "../../data/summon.db");
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const args = ["exec", "prisma", ...process.argv.slice(2).filter((arg) => arg !== "--")];

const result = spawnSync(command, args, {
  cwd: packageDir,
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? `file:${defaultDbPath}`,
  },
});

process.exit(result.status ?? 1);
