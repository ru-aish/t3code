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

  it("preserves code fences and ordinary Markdown", () => {
    const sample = "Example\n\n```jsx\n<box gap={2}>Keep literal code</box>\n```\n\n**Regular**";
    expect(formatDilMarkdown(sample)).toBe(sample);
  });
});
