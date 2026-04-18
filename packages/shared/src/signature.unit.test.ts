import { describe, expect, it } from "vitest";
import { buildHtmlSignature, buildTextSignature } from "./signature";

describe("buildTextSignature", () => {
  it("renders name, role · company, and website when all set", () => {
    const text = buildTextSignature({
      displayName: "Emma N.",
      description: "Personal Assistant",
      profileImageUrl: null,
      companyName: "Example Co",
      companyWebsite: "example.test",
    });

    expect(text).toBe(
      "\n\n-- \nEmma N.\nPersonal Assistant · Example Co\nw  example.test\n",
    );
  });

  it("renders just the name when no other fields set", () => {
    const text = buildTextSignature({
      displayName: "Emma N.",
      description: null,
      profileImageUrl: null,
    });

    expect(text).toBe("\n\n-- \nEmma N.\n");
  });

  it("strips the protocol from companyWebsite", () => {
    const text = buildTextSignature({
      displayName: "Emma",
      description: null,
      profileImageUrl: null,
      companyWebsite: "https://example.test/",
    });

    expect(text).toContain("w  example.test\n");
    expect(text).not.toContain("https://");
  });

  it("omits company portion of subtitle when only role is set", () => {
    const text = buildTextSignature({
      displayName: "Emma",
      description: "Personal Assistant",
      profileImageUrl: null,
    });

    expect(text).toContain("Personal Assistant\n");
    expect(text).not.toContain(" · ");
  });
});

describe("buildHtmlSignature", () => {
  it("includes the round <img>, subtitle, divider, and website link when all fields set", () => {
    const html = buildHtmlSignature({
      displayName: "Emma N.",
      description: "Personal Assistant",
      profileImageUrl: "https://pub-example.test/pfps/emma.png",
      companyName: "Example Co",
      companyWebsite: "example.test",
    });

    expect(html).toContain('src="https://pub-example.test/pfps/emma.png"');
    expect(html).toContain('alt="Emma N."');
    expect(html).toContain("Emma N.");
    expect(html).toContain("Personal Assistant · Example Co");
    expect(html).toContain('href="https://example.test"');
    expect(html).toContain(">example.test<");
    expect(html).toContain("<table");
  });

  it("omits the <img> cell when profileImageUrl is null", () => {
    const html = buildHtmlSignature({
      displayName: "Emma",
      description: null,
      profileImageUrl: null,
    });

    expect(html).not.toContain("<img");
    expect(html).toContain("Emma");
  });

  it("omits the website row (and its divider) when companyWebsite is null", () => {
    const html = buildHtmlSignature({
      displayName: "Emma",
      description: "Personal Assistant",
      profileImageUrl: null,
      companyName: "Example Co",
    });

    expect(html).not.toContain("href=");
    expect(html).not.toContain("background:#e5e7eb");
    expect(html).toContain("Personal Assistant · Example Co");
  });

  it("escapes HTML-special characters in rendered fields", () => {
    const html = buildHtmlSignature({
      displayName: "A & B <test>",
      description: "Role <x>",
      profileImageUrl: "https://pub-example.test/pfps/a&b.png",
      companyName: "Co & Co",
      companyWebsite: "co&co.test",
    });

    expect(html).toContain("A &amp; B &lt;test&gt;");
    expect(html).toContain("Role &lt;x&gt; · Co &amp; Co");
    expect(html).toContain("a&amp;b.png");
    expect(html).toContain("co&amp;co.test");
    expect(html).not.toContain("<test>");
  });
});
