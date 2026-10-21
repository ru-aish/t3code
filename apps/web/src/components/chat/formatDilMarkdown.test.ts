import { describe, expect, it } from "@effect/vitest";
import { formatDilMarkdown } from "./formatDilMarkdown.ts";

describe("ChatGPT DIL Markdown compatibility", () => {
  it("keeps existing final answers legible and keeps the download link", () => {
    const text = [
      "## Build ready",
      '<box gap={2}><row align="center"><icon name="check-circle"/> **Build passed**</row>',
      '<button block onClick={()=>GenUI.openUrl("https://example.com/appimage")}>Download AppImage</button>',
      "</box>",
    ].join("\n");
    const output = formatDilMarkdown(text);
    expect(output).toContain("## Build ready");
    expect(output).toContain("**Build passed**");
    expect(output).toContain("[Download AppImage](https://example.com/appimage)");
    expect(output).not.toContain("<box");
    expect(output).not.toContain("GenUI.openUrl");
    expect(formatDilMarkdown('<box>\n<button onClick={()=>GenUI.openUrl("https://example.com/file")}><icon name="download"/>Get file</button>\n</box>')).toContain("[Get file](https://example.com/file)");
  });

  it("renders ChatGPT URL references into clickable Markdown", () => {
    const source = "Open urlPR \\#19https://github.com/ru-aish/t3code/pull/19.";
    expect(formatDilMarkdown(source)).toBe(
      "Open [PR \\#19](<https://github.com/ru-aish/t3code/pull/19>).",
    );
    expect(formatDilMarkdown("urlDev serverhttp://localhost:6882/")).toBe(
      "[Dev server](<http://localhost:6882/>)",
    );
    expect(formatDilMarkdown("urlA [bracket]https://example.com/path(a)")).toBe(
      "[A \\[bracket\\]](<https://example.com/path(a)>)",
    );
  });

  it("repairs the malformed GitHub link shown in the browser", () => {
    const input = "I checked the live GitHub PR list for **urlru-aish/t3code[https://github.com/ru-aish/t3code/pulls**\\](https://github.com/ru-aish/t3code/pulls%EE%88%81**%5C).";
    expect(formatDilMarkdown(input)).toBe(
      "I checked the live GitHub PR list for **[ru\\-aish/t3code](<https://github.com/ru-aish/t3code/pulls>)**.",
    );
  });

  it("never turns non-http URL markers into unsafe links", () => {
    expect(formatDilMarkdown("urlClickjavascript:alert(1)")).toBe("Click");
    expect(formatDilMarkdown("urlBadhttps://user:password@example.com/")).toBe("Bad");
    expect(formatDilMarkdown("urlUnfinishedhttps://example.com/")).toBe(
      "urlUnfinishedhttps://example.com/",
    );
  });

  it("preserves code fences, inline code and ordinary Markdown", () => {
    const sample = "Example\n\n```jsx\n<box gap={2}>Keep literal code</box>\nurlliteralhttps://example.com\n```\n\n`urlinlinehttps://example.com`\n\n**Regular**";
    expect(formatDilMarkdown(sample)).toBe(sample);
    expect(formatDilMarkdown("Text ```jsx\nurltesthttps://example.com")).toBe(
      "Text ```jsx\nurltesthttps://example.com",
    );
    expect(formatDilMarkdown("A urlrealhttps://example.com and `urlfakehttps://example.com`")).toBe(
      "A [real](<https://example.com/>) and `urlfakehttps://example.com`",
    );
  });
});
