import fs from "fs";
import path from "path";

export function findRepoRoot(startDir = process.cwd()): string {
  let dir = path.resolve(startDir);

  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return path.resolve(startDir);
}

export function getAgentsDir(startDir = process.cwd()): string {
  return path.join(findRepoRoot(startDir), "packages", "worker", "agents");
}

export function getAgentDir(agentId: string, startDir = process.cwd()): string {
  return path.join(getAgentsDir(startDir), agentId);
}
