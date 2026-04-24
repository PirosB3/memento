import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSharedSkillsLink,
  loadSkillManifest,
  renderSkillManifest,
} from "./skill-manifest";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function createWorkspace() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-manifest-"));
  tempDirs.push(rootDir);

  const agentDir = path.join(rootDir, "packages", "worker", "agents", "agent-1");
  const sharedDir = path.join(rootDir, "packages", "worker", "shared");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });

  return { agentDir, sharedDir };
}

function writeSkill(root: string, relativeDir: string, frontmatter: string) {
  const skillDir = path.join(root, relativeDir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${frontmatter}\n# Body\n`, "utf-8");
}

describe("skill manifest", () => {
  it("discovers local and shared skills with deterministic agent-readable paths", () => {
    const { agentDir, sharedDir } = createWorkspace();
    fs.symlinkSync("../../shared", path.join(agentDir, "shared"), "dir");

    writeSkill(
      path.join(agentDir, "skills"),
      "planner",
      `---
name: planner
description: Plan owner work.
allowed-tools: Bash Read
compatibility: "Requires planner CLI."
---`,
    );
    writeSkill(
      path.join(sharedDir, "skills"),
      "browserbase/search",
      `---
name: search
description: Search the web.
allowed-tools: Bash
---`,
    );

    const result = loadSkillManifest(agentDir);

    expect(result.warnings).toEqual([]);
    expect(result.entries).toEqual([
      {
        id: "planner",
        name: "planner",
        description: "Plan owner work.",
        path: "skills/planner/SKILL.md",
        allowedTools: "Bash Read",
        compatibility: "Requires planner CLI.",
      },
      {
        id: "browserbase:search",
        name: "search",
        description: "Search the web.",
        path: "shared/skills/browserbase/search/SKILL.md",
        allowedTools: "Bash",
        compatibility: undefined,
      },
    ]);
  });

  it("omits malformed skills and duplicate ids without throwing", () => {
    const { agentDir, sharedDir } = createWorkspace();
    fs.symlinkSync("../../shared", path.join(agentDir, "shared"), "dir");

    writeSkill(
      path.join(agentDir, "skills"),
      "search",
      `---
name: search
description: Local search.
---`,
    );
    writeSkill(
      path.join(sharedDir, "skills"),
      "search",
      `---
name: search
description: Shared duplicate search.
---`,
    );
    writeSkill(
      path.join(sharedDir, "skills"),
      "broken",
      `---
name: broken
---`,
    );
    fs.mkdirSync(path.join(sharedDir, "skills", "nofrontmatter"), { recursive: true });
    fs.writeFileSync(
      path.join(sharedDir, "skills", "nofrontmatter", "SKILL.md"),
      "# No frontmatter\n",
      "utf-8",
    );

    const result = loadSkillManifest(agentDir);

    expect(result.entries.map((entry) => entry.id)).toEqual(["search"]);
    expect(result.warnings).toEqual([
      `Omitted skill missing name or description: shared/skills/broken/SKILL.md`,
      `Omitted skill without valid frontmatter: shared/skills/nofrontmatter/SKILL.md`,
      `Omitted duplicate skill id "search": shared/skills/search/SKILL.md`,
    ]);
  });

  it("renders a compact Codex-style manifest", () => {
    const manifest = renderSkillManifest([
      {
        id: "browserbase:search",
        name: "search",
        description: "Search the web.",
        path: "shared/skills/browserbase/search/SKILL.md",
        allowedTools: "Bash",
        compatibility: "Requires Browserbase.",
      },
    ]);

    expect(manifest).toContain("## AVAILABLE SKILLS");
    expect(manifest).toContain("Skill bodies are not loaded automatically.");
    expect(manifest).toContain(
      "- browserbase:search: Search the web. (path: shared/skills/browserbase/search/SKILL.md; allowed-tools: Bash; compatibility: Requires Browserbase.)",
    );
  });

  it("loads shared skills after creating the shared symlink", () => {
    const { agentDir, sharedDir } = createWorkspace();
    writeSkill(
      path.join(sharedDir, "skills"),
      "gws",
      `---
name: gws
description: Use Google Workspace.
---`,
    );

    const linkResult = ensureSharedSkillsLink(agentDir);
    const manifest = loadSkillManifest(agentDir);

    expect(linkResult).toEqual({ created: true });
    expect(manifest.entries).toEqual([
      {
        id: "gws",
        name: "gws",
        description: "Use Google Workspace.",
        path: "shared/skills/gws/SKILL.md",
        allowedTools: undefined,
        compatibility: undefined,
      },
    ]);
  });
});
