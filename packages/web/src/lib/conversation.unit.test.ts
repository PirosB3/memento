import { describe, expect, it } from "vitest";
import {
  buildDisplayBlocks,
  getLatestConversationPreview,
  type ConversationRow,
} from "./conversation";

function buildConversationRow(
  overrides: Partial<ConversationRow> = {},
): ConversationRow {
  return {
    id: 1,
    role: "assistant",
    message: JSON.stringify({
      role: "assistant",
      content: "Default message",
    }),
    timestamp: "2026-04-11T12:00:00.000Z",
    orderingKey: "019dc00a-0000-7000-8000-000000000000",
    ...overrides,
  };
}

describe("conversation latest preview", () => {
  it("returns the latest assistant text message", () => {
    const preview = getLatestConversationPreview([
      buildConversationRow({
        message: JSON.stringify({
          role: "assistant",
          content: "Wrapped up the outreach and sent the update.",
        }),
      }),
    ]);

    expect(preview).toEqual({
      kind: "role",
      label: "assistant",
      preview: "Wrapped up the outreach and sent the update.",
      timestamp: "2026-04-11T12:00:00.000Z",
    });
  });

  it("returns the latest user text message", () => {
    const preview = getLatestConversationPreview([
      buildConversationRow({
        id: 2,
        role: "user",
        message: JSON.stringify({
          role: "user",
          content: "Please follow up again tomorrow morning.",
        }),
      }),
    ]);

    expect(preview).toEqual({
      kind: "role",
      label: "user",
      preview: "Please follow up again tomorrow morning.",
      timestamp: "2026-04-11T12:00:00.000Z",
    });
  });

  it("summarizes the latest tool result from a tool call pair", () => {
    const preview = getLatestConversationPreview([
      buildConversationRow({
        id: 3,
        role: "assistant",
        message: JSON.stringify({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { cmd: "ls -la" },
            },
          ],
        }),
      }),
      buildConversationRow({
        id: 4,
        role: "tool",
        timestamp: "2026-04-11T12:00:05.000Z",
        message: JSON.stringify({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "total 8\n-rw-r--r-- file.txt" }],
        }),
      }),
    ]);

    expect(preview).toEqual({
      kind: "toolResult",
      label: "bash result",
      preview: "total 8 -rw-r--r-- file.txt",
      timestamp: "2026-04-11T12:00:05.000Z",
    });
  });

  it("handles orphan tool results", () => {
    const preview = getLatestConversationPreview([
      buildConversationRow({
        id: 5,
        role: "tool",
        message: JSON.stringify({
          role: "toolResult",
          toolName: "read_file",
          content: [{ type: "text", text: "Loaded contacts.json" }],
        }),
      }),
    ]);

    expect(preview).toEqual({
      kind: "toolResult",
      label: "read_file result",
      preview: "Loaded contacts.json",
      timestamp: "2026-04-11T12:00:00.000Z",
    });
  });

  it("returns null when the conversation is empty", () => {
    expect(getLatestConversationPreview([])).toBeNull();
  });

  it("ignores thinking-only rows for the latest preview", () => {
    const preview = getLatestConversationPreview([
      buildConversationRow({
        id: 6,
        timestamp: "2026-04-11T12:00:00.000Z",
        message: JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "Waiting for the venue response." }],
        }),
      }),
      buildConversationRow({
        id: 7,
        timestamp: "2026-04-11T12:01:00.000Z",
        message: JSON.stringify({
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "",
              thinkingSignature: JSON.stringify({
                type: "reasoning",
                encrypted_content: "opaque",
              }),
            },
          ],
        }),
      }),
    ]);

    expect(preview).toEqual({
      kind: "role",
      label: "assistant",
      preview: "Waiting for the venue response.",
      timestamp: "2026-04-11T12:00:00.000Z",
    });
  });
});

describe("conversation thinking blocks", () => {
  it("renders readable thinking as a display block", () => {
    const blocks = buildDisplayBlocks([
      buildConversationRow({
        message: JSON.stringify({
          role: "assistant",
          content: [{ type: "thinking", thinking: "I should check the latest thread first." }],
        }),
      }),
    ]);

    expect(blocks).toEqual([
      {
        kind: "thinking",
        rowId: 1,
        text: "I should check the latest thread first.",
        timestamp: "2026-04-11T12:00:00.000Z",
      },
    ]);
  });

  it("renders a safe fallback for empty thinking metadata", () => {
    const blocks = buildDisplayBlocks([
      buildConversationRow({
        message: JSON.stringify({
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "",
              thinkingSignature: JSON.stringify({
                type: "reasoning",
                encrypted_content: "opaque",
              }),
            },
          ],
        }),
      }),
    ]);

    expect(blocks).toEqual([
      {
        kind: "thinking",
        rowId: 1,
        text: "Thinking metadata recorded, no readable summary available.",
        timestamp: "2026-04-11T12:00:00.000Z",
      },
    ]);
  });

  it("keeps thinking and text parts in order without exposing signatures", () => {
    const blocks = buildDisplayBlocks([
      buildConversationRow({
        message: JSON.stringify({
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "I need to verify the schedule.",
              thinkingSignature: JSON.stringify({
                type: "reasoning",
                encrypted_content: "opaque",
              }),
            },
            { type: "text", text: "I checked the schedule and found one opening." },
          ],
        }),
      }),
    ]);

    expect(blocks).toEqual([
      {
        kind: "thinking",
        rowId: 1,
        text: "I need to verify the schedule.",
        timestamp: "2026-04-11T12:00:00.000Z",
      },
      {
        kind: "role",
        role: "assistant",
        rowId: 1,
        text: "I checked the schedule and found one opening.",
        timestamp: "2026-04-11T12:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(blocks)).not.toContain("encrypted_content");
  });

  it("still pairs tool calls and results when thinking appears first", () => {
    const blocks = buildDisplayBlocks([
      buildConversationRow({
        id: 2,
        message: JSON.stringify({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should list files." },
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { cmd: "ls -la" },
            },
          ],
        }),
      }),
      buildConversationRow({
        id: 3,
        role: "tool",
        message: JSON.stringify({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "total 8" }],
        }),
      }),
    ]);

    expect(blocks).toEqual([
      {
        kind: "thinking",
        rowId: 2,
        text: "I should list files.",
        timestamp: "2026-04-11T12:00:00.000Z",
      },
      {
        kind: "toolPair",
        rowId: 2,
        timestamp: "2026-04-11T12:00:00.000Z",
        resultTimestamp: "2026-04-11T12:00:00.000Z",
        call: {
          kind: "toolCall",
          id: "call-1",
          name: "bash",
          args: { cmd: "ls -la" },
        },
        result: {
          kind: "toolResult",
          id: "call-1",
          name: "bash",
          output: "total 8",
        },
      },
    ]);
  });
});
