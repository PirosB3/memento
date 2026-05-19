import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@summon/shared";
import { rehydrateImageRefs, compactImagesForStorage } from "./pi-turn";
import type { AgentMessage } from "../pi-types";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function createTempAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-turn-helpers-"));
  tempDirs.push(dir);
  return dir;
}

const log = createLogger("test").child("pi-turn-helpers");

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeToolResult(content: unknown[]): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "view_image",
    content: content as never,
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage;
}

describe("rehydrateImageRefs", () => {
  it("converts image_ref blocks to image blocks with fresh base64", () => {
    const agentDir = createTempAgentDir();
    const filePath = path.join(agentDir, "attachments", "owner.png");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, PNG_BYTES);

    const messages: AgentMessage[] = [
      makeToolResult([
        { type: "image_ref", path: "attachments/owner.png", mimeType: "image/png", size: PNG_BYTES.length },
      ]),
    ];

    rehydrateImageRefs(messages, agentDir, log);

    const block = (messages[0].content as unknown as Record<string, unknown>[])[0];
    expect(block.type).toBe("image");
    expect(block.mimeType).toBe("image/png");
    expect(block.path).toBe("attachments/owner.png");
    expect(block.size).toBe(PNG_BYTES.length);
    expect(Buffer.from(block.data as string, "base64")).toEqual(PNG_BYTES);
  });

  it("falls back to a text marker when the file is missing", () => {
    const agentDir = createTempAgentDir();
    const messages: AgentMessage[] = [
      makeToolResult([
        { type: "image_ref", path: "attachments/gone.png", mimeType: "image/png", size: 100 },
      ]),
    ];

    rehydrateImageRefs(messages, agentDir, log);

    const block = (messages[0].content as unknown as Record<string, unknown>[])[0];
    expect(block.type).toBe("text");
    expect(block.text).toMatch(/no longer available/);
  });

  it("falls back when the path tries to escape the workspace", () => {
    const agentDir = createTempAgentDir();
    const messages: AgentMessage[] = [
      makeToolResult([
        { type: "image_ref", path: "../../../etc/hosts", mimeType: "image/png", size: 100 },
      ]),
    ];

    rehydrateImageRefs(messages, agentDir, log);

    const block = (messages[0].content as unknown as Record<string, unknown>[])[0];
    expect(block.type).toBe("text");
    expect(block.text).toMatch(/no longer available/);
  });

  it("leaves text and existing image blocks untouched", () => {
    const agentDir = createTempAgentDir();
    const messages: AgentMessage[] = [
      makeToolResult([
        { type: "text", text: "hello" },
        { type: "image", data: "abc", mimeType: "image/jpeg" },
      ]),
    ];

    rehydrateImageRefs(messages, agentDir, log);

    const blocks = messages[0].content as unknown as Record<string, unknown>[];
    expect(blocks[0]).toEqual({ type: "text", text: "hello" });
    expect(blocks[1]).toEqual({ type: "image", data: "abc", mimeType: "image/jpeg" });
  });

  it("ignores messages with string content", () => {
    const agentDir = createTempAgentDir();
    const messages: AgentMessage[] = [
      { role: "user", content: "plain text", timestamp: 0 } as unknown as AgentMessage,
    ];

    expect(() => rehydrateImageRefs(messages, agentDir, log)).not.toThrow();
    expect(messages[0].content).toBe("plain text");
  });
});

describe("compactImagesForStorage", () => {
  it("replaces disk-backed image blocks with image_ref markers", () => {
    const msg = makeToolResult([
      {
        type: "image",
        data: "BASE64DATA",
        mimeType: "image/png",
        path: "attachments/owner.png",
        size: 1234,
      },
    ]);

    const out = compactImagesForStorage(msg);

    const block = (out.content as unknown as Record<string, unknown>[])[0];
    expect(block).toEqual({
      type: "image_ref",
      path: "attachments/owner.png",
      mimeType: "image/png",
      size: 1234,
    });
    expect(block.data).toBeUndefined();
  });

  it("leaves the message unchanged when no path-tagged image is present", () => {
    const msg = makeToolResult([
      { type: "text", text: "hi" },
      { type: "image", data: "raw", mimeType: "image/png" }, // no path → not disk-backed
    ]);

    const out = compactImagesForStorage(msg);
    expect(out).toBe(msg);
  });

  it("does not mutate the input message", () => {
    const original = [
      {
        type: "image",
        data: "BASE64DATA",
        mimeType: "image/png",
        path: "x.png",
        size: 1,
      },
    ];
    const msg = makeToolResult(original);

    compactImagesForStorage(msg);

    expect((msg.content as unknown as Record<string, unknown>[])[0].data).toBe("BASE64DATA");
  });

  it("handles string content as a no-op", () => {
    const msg = { role: "user", content: "hi", timestamp: 0 } as unknown as AgentMessage;
    expect(compactImagesForStorage(msg)).toBe(msg);
  });
});
