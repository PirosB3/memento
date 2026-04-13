import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadFileTool, createWriteFileTool } from "./file-tools";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function createWorkspace() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-tools-"));
  tempDirs.push(rootDir);

  const agentDir = path.join(rootDir, "packages", "worker", "agents", "agent-1");
  const sharedDir = path.join(rootDir, "packages", "worker", "shared");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.symlinkSync("../../shared", path.join(agentDir, "shared"), "dir");

  return { agentDir, sharedDir };
}

function getText(result: Awaited<ReturnType<ReturnType<typeof createReadFileTool>["execute"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("file tools", () => {
  it("allows reading shared skill files through the shared symlink", async () => {
    const { agentDir, sharedDir } = createWorkspace();
    fs.mkdirSync(path.join(sharedDir, "skills", "gws"), { recursive: true });
    fs.writeFileSync(path.join(sharedDir, "skills", "gws", "SKILL.md"), "shared skill", "utf-8");

    const tool = createReadFileTool(agentDir);
    const result = await tool.execute("call-1", { path: "shared/skills/gws/SKILL.md" });

    expect(result.details).toEqual({ path: "shared/skills/gws/SKILL.md", size: 12 });
    expect(getText(result)).toBe("shared skill");
  });

  it("rejects writes into the shared symlink target", async () => {
    const { agentDir, sharedDir } = createWorkspace();
    fs.mkdirSync(path.join(sharedDir, "skills", "gws"), { recursive: true });
    fs.writeFileSync(path.join(sharedDir, "skills", "gws", "SKILL.md"), "original", "utf-8");

    const tool = createWriteFileTool(agentDir);
    const result = await tool.execute("call-2", {
      path: "shared/skills/gws/SKILL.md",
      content: "overwritten",
    });

    expect(result.details).toEqual({ error: true });
    expect(getText(result)).toContain("Cannot modify read-only shared files");
    expect(fs.readFileSync(path.join(sharedDir, "skills", "gws", "SKILL.md"), "utf-8")).toBe("original");
  });

  it("rejects user-created symlinks that point outside the workspace", async () => {
    const { agentDir } = createWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    tempDirs.push(outsideDir);
    fs.symlinkSync(outsideDir, path.join(agentDir, "escape"), "dir");

    const tool = createWriteFileTool(agentDir);
    const result = await tool.execute("call-3", {
      path: "escape/secrets.txt",
      content: "nope",
    });

    expect(result.details).toEqual({ error: true });
    expect(getText(result)).toContain("Path resolves outside the agent workspace");
    expect(fs.existsSync(path.join(outsideDir, "secrets.txt"))).toBe(false);
  });
});
