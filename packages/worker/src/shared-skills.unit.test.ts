import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function listFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

describe("shared skills docs", () => {
  it("do not contain stale Claude-specific workspace paths", () => {
    const skillsDir = path.resolve("packages", "worker", "shared", "skills");
    const textFiles = listFiles(skillsDir).filter((filePath) => /\.(md|txt|html|mjs|json)$/i.test(filePath));
    const forbiddenPatterns = [
      ".claude/skills",
      ".claude/settings.json",
      "~/.claude/settings.json",
      "~/.claude/skills",
    ];

    const offenders = textFiles.flatMap((filePath) => {
      const contents = fs.readFileSync(filePath, "utf-8");
      return forbiddenPatterns
        .filter((pattern) => contents.includes(pattern))
        .map((pattern) => `${path.relative(process.cwd(), filePath)} -> ${pattern}`);
    });

    expect(offenders).toEqual([]);
  });
});
