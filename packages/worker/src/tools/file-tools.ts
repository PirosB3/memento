import { Type } from "@sinclair/typebox";
import fs from "fs";
import path from "path";
import type { AgentTool } from "../../pi-types.js";

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolveCanonicalPath(candidatePath: string): string {
  const pendingSegments: string[] = [];
  let currentPath = candidatePath;

  while (!fs.existsSync(currentPath)) {
    pendingSegments.unshift(path.basename(currentPath));
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`No existing ancestor for path: ${candidatePath}`);
    }
    currentPath = parentPath;
  }

  return path.join(fs.realpathSync(currentPath), ...pendingSegments);
}

function getSharedRoot(agentDir: string): string | null {
  const sharedPath = path.join(agentDir, "shared");
  if (!fs.existsSync(sharedPath)) return null;

  try {
    return fs.realpathSync(sharedPath);
  } catch {
    return null;
  }
}

export function resolveAuthorizedPath(
  agentDir: string,
  requestedPath: string,
  mode: "read" | "write",
): { path?: string; error?: string } {
  const candidatePath = path.resolve(agentDir, requestedPath);
  if (!isWithinRoot(candidatePath, agentDir)) {
    return { error: "Error: Path traversal not allowed." };
  }

  const canonicalAgentDir = fs.realpathSync(agentDir);
  const canonicalPath = resolveCanonicalPath(candidatePath);
  if (isWithinRoot(canonicalPath, canonicalAgentDir)) {
    return { path: canonicalPath };
  }

  const sharedRoot = getSharedRoot(agentDir);
  if (sharedRoot && isWithinRoot(canonicalPath, sharedRoot)) {
    if (mode === "read") {
      return { path: canonicalPath };
    }
    return { error: "Error: Cannot modify read-only shared files." };
  }

  return { error: "Error: Path resolves outside the agent workspace." };
}

export function createReadFileTool(agentDir: string): AgentTool {
  return {
    name: "read_file",
    label: "Read File",
    description: "Read a file from the agent's working directory.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to the file" }),
    }),
    execute: async (_toolCallId, params) => {
      const p = params as { path: string };
      const resolvedPath = resolveAuthorizedPath(agentDir, p.path, "read");
      if (!resolvedPath.path) {
        return {
          content: [
            { type: "text" as const, text: resolvedPath.error ?? "Error: Path traversal not allowed." },
          ],
          details: { error: true },
        };
      }
      try {
        const content = fs.readFileSync(resolvedPath.path, "utf-8");
        return {
          content: [{ type: "text" as const, text: content }],
          details: { path: p.path, size: content.length },
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `File not found or unreadable: ${p.path}`,
            },
          ],
          details: { error: true },
        };
      }
    },
  };
}

export function createWriteFileTool(agentDir: string): AgentTool {
  return {
    name: "write_file",
    label: "Write File",
    description:
      "Write or overwrite a file in the agent's working directory. Creates parent directories if needed.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to the file" }),
      content: Type.String({ description: "File content to write" }),
    }),
    execute: async (_toolCallId, params) => {
      const p = params as { path: string; content: string };
      const resolvedPath = resolveAuthorizedPath(agentDir, p.path, "write");
      if (!resolvedPath.path) {
        return {
          content: [
            { type: "text" as const, text: resolvedPath.error ?? "Error: Path traversal not allowed." },
          ],
          details: { error: true },
        };
      }
      try {
        fs.mkdirSync(path.dirname(resolvedPath.path), { recursive: true });
        fs.writeFileSync(resolvedPath.path, p.content, "utf-8");
        return {
          content: [
            {
              type: "text" as const,
              text: `File written successfully: ${p.path} (${p.content.length} bytes)`,
            },
          ],
          details: { path: p.path, size: p.content.length },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: { error: true },
        };
      }
    },
  };
}
