import { Type } from "@sinclair/typebox";
import fs from "fs";
import path from "path";
import type { AgentTool } from "../../pi-types.js";
import { resolveAuthorizedPath } from "./file-tools.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function inferMimeType(filePath: string): string | null {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

export function createViewImageTool(agentDir: string): AgentTool {
  return {
    name: "view_image",
    label: "View Image",
    description:
      "Load an image file from the agent's working directory and make it visible to you on this turn. Supports png, jpg, jpeg, gif, webp up to 10MB. Use this after download_email_attachment to actually see an attached image, or to inspect any image already saved under the workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path to the image file" }),
    }),
    execute: async (_toolCallId, params) => {
      const p = params as { path: string };
      const mimeType = inferMimeType(p.path);
      if (!mimeType) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unsupported image extension: ${p.path}. Supported: .png, .jpg, .jpeg, .gif, .webp.`,
            },
          ],
          details: { error: true, path: p.path },
        };
      }

      const resolved = resolveAuthorizedPath(agentDir, p.path, "read");
      if (!resolved.path) {
        return {
          content: [
            { type: "text" as const, text: resolved.error ?? "Error: Path traversal not allowed." },
          ],
          details: { error: true },
        };
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved.path);
      } catch {
        return {
          content: [
            { type: "text" as const, text: `File not found or unreadable: ${p.path}` },
          ],
          details: { error: true, path: p.path },
        };
      }

      if (!stat.isFile()) {
        return {
          content: [{ type: "text" as const, text: `Not a file: ${p.path}` }],
          details: { error: true, path: p.path },
        };
      }

      if (stat.size > MAX_IMAGE_BYTES) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Image too large: ${stat.size} bytes (limit ${MAX_IMAGE_BYTES}). Resize before viewing.`,
            },
          ],
          details: { error: true, path: p.path, size: stat.size },
        };
      }

      const bytes = fs.readFileSync(resolved.path);
      const data = bytes.toString("base64");

      // Tag the image block with `path` and `size` so the persist-transform in
      // pi-turn can swap data for an image_ref before storing in the DB. The
      // extra fields are ignored by Pi's serializer (it reads only `data` and
      // `mimeType`) so they survive in-memory state without affecting the
      // model send.
      const imageBlock = {
        type: "image" as const,
        data,
        mimeType,
        path: p.path,
        size: stat.size,
      };

      return {
        content: [imageBlock as unknown as { type: "image"; data: string; mimeType: string }],
        details: { path: p.path, mimeType, size: stat.size },
      };
    },
  };
}
