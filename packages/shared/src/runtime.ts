import fs from "node:fs";
import path from "node:path";

const DEFAULT_TEMPORAL_ADDRESS = "localhost:7233";
const WORKSPACE_ROOT = findWorkspaceRoot();
const DEFAULT_DATABASE_URL = "postgresql://summon:summon@localhost:5432/summon_dev";
const DEFAULT_DATABASE_READONLY_URL = "postgresql://summon_readonly:summon_readonly@localhost:5432/summon_dev";

function findWorkspaceRoot(): string {
  let dir = process.cwd();

  for (let i = 0; i < 6; i++) {
    const workspaceFile = path.join(dir, "pnpm-workspace.yaml");
    const dataDir = path.join(dir, "data");

    if (fs.existsSync(workspaceFile) || fs.existsSync(dataDir)) {
      return dir;
    }

    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      break;
    }

    dir = parentDir;
  }

  return process.cwd();
}

export function getTemporalAddress(): string {
  return process.env.TEMPORAL_ADDRESS || DEFAULT_TEMPORAL_ADDRESS;
}

export function getDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

export function getDatabaseReadonlyUrl(): string | undefined {
  return process.env.DATABASE_READONLY_URL || DEFAULT_DATABASE_READONLY_URL;
}

export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT;
}

export function getAgentsDir(): string {
  return path.join(WORKSPACE_ROOT, "packages", "worker", "agents");
}
