import fs from "fs";
import path from "path";

export interface SkillManifestEntry {
  id: string;
  name: string;
  description: string;
  path: string;
  allowedTools?: string;
  compatibility?: string;
}

export interface SkillManifestResult {
  entries: SkillManifestEntry[];
  warnings: string[];
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  allowedTools?: string;
  compatibility?: string;
}

export function ensureSharedSkillsLink(agentDir: string): { created: boolean; warning?: string } {
  const sharedLinkPath = path.join(agentDir, "shared");
  if (fs.existsSync(sharedLinkPath)) {
    return { created: false };
  }

  try {
    fs.symlinkSync("../../shared", sharedLinkPath, "dir");
    return { created: true };
  } catch (err) {
    return {
      created: false,
      warning: `Failed to create shared/ symlink: ${String(err)}`,
    };
  }
}

export function loadSkillManifest(agentDir: string): SkillManifestResult {
  const warnings: string[] = [];
  const entries: SkillManifestEntry[] = [];
  const seenIds = new Set<string>();

  const roots = [
    { root: path.join(agentDir, "skills"), prefix: "skills" },
    { root: path.join(agentDir, "shared", "skills"), prefix: path.join("shared", "skills") },
  ];

  try {
    for (const skillRoot of roots) {
      const skillFiles = findSkillFiles(skillRoot.root);
      for (const filePath of skillFiles) {
        const relativeSkillDir = path.relative(skillRoot.root, path.dirname(filePath));
        const agentPath = normalizeAgentPath(path.join(skillRoot.prefix, relativeSkillDir, "SKILL.md"));
        const parsed = parseSkillFile(filePath);

        if (!parsed) {
          warnings.push(`Omitted skill without valid frontmatter: ${agentPath}`);
          continue;
        }

        if (!parsed.name || !parsed.description) {
          warnings.push(`Omitted skill missing name or description: ${agentPath}`);
          continue;
        }

        const id = skillIdFor(relativeSkillDir, parsed.name);
        if (seenIds.has(id)) {
          warnings.push(`Omitted duplicate skill id "${id}": ${agentPath}`);
          continue;
        }

        seenIds.add(id);
        entries.push({
          id,
          name: parsed.name,
          description: parsed.description,
          path: agentPath,
          allowedTools: parsed.allowedTools,
          compatibility: parsed.compatibility,
        });
      }
    }
  } catch (err) {
    warnings.push(`Failed to load skill manifest: ${String(err)}`);
    return { entries: [], warnings };
  }

  return { entries, warnings };
}

export function renderSkillManifest(entries: SkillManifestEntry[]): string {
  if (entries.length === 0) return "";

  const lines = [
    "## AVAILABLE SKILLS",
    "Skill bodies are not loaded automatically. When a task matches a skill description, read that skill's `SKILL.md` with `read_file` before using it.",
    "Resolve relative references from the skill directory. Do not read unrelated skill files.",
    "",
  ];

  for (const entry of entries) {
    const details = [`path: ${entry.path}`];
    if (entry.allowedTools) details.push(`allowed-tools: ${entry.allowedTools}`);
    if (entry.compatibility) details.push(`compatibility: ${entry.compatibility}`);
    lines.push(`- ${entry.id}: ${entry.description} (${details.join("; ")})`);
  }

  return lines.join("\n");
}

function findSkillFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];

  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(fullPath);
      }
    }
  }

  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target does not include Array#toSorted.
  return files.sort((a, b) => normalizeAgentPath(a).localeCompare(normalizeAgentPath(b)));
}

function parseSkillFile(filePath: string): SkillFrontmatter | null {
  const content = fs.readFileSync(filePath, "utf-8");
  if (!content.startsWith("---\n")) return null;

  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;

  const frontmatter = content.slice(4, end);
  const result: SkillFrontmatter = {};

  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;

    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    const value = unquoteScalar(match[2].trim());
    if (key === "name") result.name = value;
    if (key === "description") result.description = value;
    if (key === "allowed-tools") result.allowedTools = value;
    if (key === "compatibility") result.compatibility = value;
  }

  return result;
}

function unquoteScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function skillIdFor(relativeSkillDir: string, name: string): string {
  const segments = normalizeAgentPath(relativeSkillDir)
    .split("/")
    .filter((segment) => segment && segment !== ".");

  if (segments.length <= 1) return name;
  return `${segments[0]}:${name}`;
}

function normalizeAgentPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
