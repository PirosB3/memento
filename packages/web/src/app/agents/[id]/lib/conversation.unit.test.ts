import { describe, expect, it } from "vitest";
import { getLatestConversationPreview, type ConversationRow } from "./conversation";

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
});
