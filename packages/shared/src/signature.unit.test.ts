import { describe, expect, it } from "vitest";
import { buildHtmlSignature, buildTextSignature } from "./signature";

describe("buildTextSignature", () => {
  it("emits the standard sig delimiter with name and description", () => {
    const text = buildTextSignature({
      displayName: "Emma P.",
      description: "Inbox concierge for the Smith household.",
      profileImageUrl: null,
    });

    expect(text).toBe("\n\n-- \nEmma P.\nInbox concierge for the Smith household.\n");
  });

  it("omits the description line when description is null", () => {
    const text = buildTextSignature({
      displayName: "Emma P.",
      description: null,
      profileImageUrl: null,
    });

    expect(text).toBe("\n\n-- \nEmma P.\n");
  });

  it("treats whitespace-only descriptions as missing", () => {
    const text = buildTextSignature({
      displayName: "Emma P.",
      description: "   ",
      profileImageUrl: null,
    });

    expect(text).toBe("\n\n-- \nEmma P.\n");
  });
});

describe("buildHtmlSignature", () => {
  it("includes an <img> tag when profileImageUrl is set", () => {
    const html = buildHtmlSignature({
      displayName: "Emma P.",
      description: "Inbox concierge for the Smith household.",
      profileImageUrl: "https://pub-example.test/pfps/agent-1.png",
    });

    expect(html).toContain('src="https://pub-example.test/pfps/agent-1.png"');
    expect(html).toContain('alt="Emma P."');
    expect(html).toContain("Emma P.");
    expect(html).toContain("Inbox concierge for the Smith household.");
    expect(html).toContain("<table");
  });

  it("omits the <img> tag when profileImageUrl is null but still renders text", () => {
    const html = buildHtmlSignature({
      displayName: "Emma P.",
      description: "Inbox concierge for the Smith household.",
      profileImageUrl: null,
    });

    expect(html).not.toContain("<img");
    expect(html).toContain("Emma P.");
    expect(html).toContain("Inbox concierge for the Smith household.");
  });

  it("omits the description div when description is null", () => {
    const html = buildHtmlSignature({
      displayName: "Emma P.",
      description: null,
      profileImageUrl: "https://pub-example.test/pfps/agent-1.png",
    });

    expect(html).not.toContain('margin-top:2px;">');
    expect(html).toContain("Emma P.");
  });

  it("escapes HTML-special characters in all fields", () => {
    const html = buildHtmlSignature({
      displayName: "A & B <test>",
      description: "Line with <script>alert('x')</script>",
      profileImageUrl: "https://pub-example.test/pfps/a&b.png",
    });

    expect(html).toContain("A &amp; B &lt;test&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a&amp;b.png");
    expect(html).not.toContain("<script>");
  });
});
