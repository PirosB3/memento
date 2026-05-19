import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createViewImageTool } from "./view-image-tool";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function createTempAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "view-image-tool-"));
  tempDirs.push(dir);
  return dir;
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text ?? "" : "";
}

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100" +
    "0d0a2db40000000049454e44ae426082",
  "hex",
);

describe("view_image tool", () => {
  it("returns an image block tagged with path/size for a valid PNG", async () => {
    const agentDir = createTempAgentDir();
    const filePath = path.join(agentDir, "attachments", "owner.png");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, TINY_PNG);

    const tool = createViewImageTool(agentDir);
    const result = await tool.execute("call-1", { path: "attachments/owner.png" });

    expect(result.content).toHaveLength(1);
    const block = result.content[0] as unknown as Record<string, unknown>;
    expect(block.type).toBe("image");
    expect(block.mimeType).toBe("image/png");
    expect(block.path).toBe("attachments/owner.png");
    expect(block.size).toBe(TINY_PNG.length);
    expect(typeof block.data).toBe("string");
    expect(Buffer.from(block.data as string, "base64")).toEqual(TINY_PNG);
    expect(result.details).toEqual({
      path: "attachments/owner.png",
      mimeType: "image/png",
      size: TINY_PNG.length,
    });
  });

  it.each([
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
  ])("infers mimeType for .%s extension", async (ext, expectedMime) => {
    const agentDir = createTempAgentDir();
    const filePath = path.join(agentDir, `pic.${ext}`);
    fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02]));

    const tool = createViewImageTool(agentDir);
    const result = await tool.execute("call-mime", { path: `pic.${ext}` });

    const block = result.content[0] as unknown as Record<string, unknown>;
    expect(block.type).toBe("image");
    expect(block.mimeType).toBe(expectedMime);
  });

  it("rejects unsupported extensions with a text result", async () => {
    const agentDir = createTempAgentDir();
    const filePath = path.join(agentDir, "doc.pdf");
    fs.writeFileSync(filePath, Buffer.from("pdf-bytes"));

    const tool = createViewImageTool(agentDir);
    const result = await tool.execute("call-pdf", { path: "doc.pdf" });

    expect(result.content[0].type).toBe("text");
    expect(getText(result)).toMatch(/Unsupported image extension/);
    expect(result.details).toMatchObject({ error: true });
  });

  it("rejects path traversal", async () => {
    const agentDir = createTempAgentDir();
    const tool = createViewImageTool(agentDir);
    const result = await tool.execute("call-traversal", {
      path: "../../../etc/hosts.png",
    });

    expect(result.content[0].type).toBe("text");
    expect(getText(result)).toMatch(/Path traversal not allowed|outside the agent workspace/);
    expect(result.details).toMatchObject({ error: true });
  });

  it("returns a text error when the file does not exist", async () => {
    const agentDir = createTempAgentDir();
    const tool = createViewImageTool(agentDir);
    const result = await tool.execute("call-missing", { path: "missing.png" });

    expect(result.content[0].type).toBe("text");
    expect(getText(result)).toMatch(/not found or unreadable/);
  });

  it("refuses files larger than 10MB", async () => {
    const agentDir = createTempAgentDir();
    const filePath = path.join(agentDir, "huge.png");
    // Pad to just over 10MB. Using a sparse-ish buffer to keep allocation cheap.
    const bigBuf = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
    fs.writeFileSync(filePath, bigBuf);

    const tool = createViewImageTool(agentDir);
    const result = await tool.execute("call-big", { path: "huge.png" });

    expect(result.content[0].type).toBe("text");
    expect(getText(result)).toMatch(/Image too large/);
    expect(result.details).toMatchObject({ error: true });
  });

  it("rejects directories that match the supported extension", async () => {
    const agentDir = createTempAgentDir();
    const dirPath = path.join(agentDir, "weird.png");
    fs.mkdirSync(dirPath, { recursive: true });

    const tool = createViewImageTool(agentDir);
    const result = await tool.execute("call-dir", { path: "weird.png" });

    expect(result.content[0].type).toBe("text");
    expect(getText(result)).toMatch(/Not a file/);
  });
});
