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
    expect(
      formatDilMarkdown(
        '<box>\n<button onClick={()=>GenUI.openUrl("https://example.com/file")}><icon name="download"/>Get file</button>\n</box>',
      ),
    ).toContain("[Get file](https://example.com/file)");
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
    const input =
      "I checked the live GitHub PR list for **urlru-aish/t3code[https://github.com/ru-aish/t3code/pulls**\\](https://github.com/ru-aish/t3code/pulls%EE%88%81**%5C).";
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
    const sample =
      "Example\n\n```jsx\n<box gap={2}>Keep literal code</box>\nurlliteralhttps://example.com\n```\n\n`urlinlinehttps://example.com`\n\n**Regular**";
    expect(formatDilMarkdown(sample)).toBe(sample);
    expect(formatDilMarkdown("Text ```jsx\nurltesthttps://example.com")).toBe(
      "Text ```jsx\n[test](<https://example.com/>)",
    );
    expect(
      formatDilMarkdown("A urlrealhttps://example.com and `urlfakehttps://example.com`"),
    ).toBe("A [real](<https://example.com/>) and `urlfakehttps://example.com`");
  });

  it("converts DIL buttons whose labels contain inline code without leaking attributes", () => {
    const source = [
      "<box>",
      '<button onClick={()=>GenUI.openUrl("https://example.com/file")}>Download `App`</button>',
      "</box>",
      "`<box>literal</box>`",
    ].join("\n");
    const output = formatDilMarkdown(source);
    expect(output).toContain("[Download `App`](https://example.com/file)");
    expect(output).toContain("`<box>literal</box>`");
    expect(output).not.toContain("GenUI.openUrl");
    expect(output).not.toContain("</button>");
    expect(output).not.toMatch(/^<\/box>$/m);
  });

  it("keeps literal URLs inside fenced code with embedded fence-like strings", () => {
    const literal = "urlliteralhttps://example.com";
    const real = "urloutsidehttps://example.com";
    const source = [
      "```js",
      'const backticks = "```";',
      literal,
      "````", // longer closing fence is valid
      real,
      "~~~jsx",
      literal,
      "~~~",
      real,
    ].join("\n");
    const output = formatDilMarkdown(source);
    expect(output.match(/urlliteral/g)).toHaveLength(2);
    expect(output.match(/\[outside\]\(<https:\/\/example.com\/>\)/g)).toHaveLength(2);
  });

  it("keeps four-backtick and tilde fences and escaped inline code intact", () => {
    const marker = "urlliteralhttps://example.com";
    const source = [
      "````jsx",
      "```" + marker,
      "````",
      "~~~",
      marker,
      "~~~~",
      "`" + marker + "`",
      "urlrealhttps://example.com",
    ].join("\n");
    const output = formatDilMarkdown(source);
    expect(output.match(/urlliteral/g)).toHaveLength(3);
    expect(output).toContain("[real](<https://example.com/>)");
  });

  it("preserves URL markers inside blockquoted and list-nested code fences", () => {
    const tick = String.fromCharCode(96).repeat(3);
    const literal = "urlliteralhttps://example.com";
    const real = "urloutsidehttps://example.com";
    for (const source of [
      ["> ~~~xml", "> " + literal, "> ~~~", real].join("\n"),
      ["- " + tick + "xml", "  " + literal, "  " + tick, real].join("\n"),
      ["    ~~~xml", "    " + literal, "    ~~~", real].join("\n"),
      ["> > " + tick + "xml", "> > " + literal, "> > " + tick, real].join("\n"),
    ]) {
      const formatted = formatDilMarkdown(source);
      expect(formatted).toContain(literal);
      expect(formatted).toContain("[outside](<https://example.com/>)");
    }
  });

  it("converts later links after an unmatched triple tick in prose", () => {
    const ticks = String.fromCharCode(96).repeat(3);
    const source = "Prose " + ticks + "not-a-fence\nurlworkinghttps://example.com";
    expect(formatDilMarkdown(source)).toContain("[working](<https://example.com/>)");
    const actualFence = ticks + "ts\nurlliteralhttps://example.com";
    expect(formatDilMarkdown(actualFence)).toBe(actualFence);
  });

  it("converts reference labels containing inline code", () => {
    expect(formatDilMarkdown("urlOpen `README.md`https://github.com/example/repo")).toBe(
      "[Open `README.md`](<https://github.com/example/repo>)",
    );
  });

  it("recovers from malformed preceding markers without swallowing a later valid link", () => {
    const input = "urlbrokenhttps://one.test/prefix urlgoodhttps://two.test";
    const output = formatDilMarkdown(input);
    expect(output).toContain("urlbroken");
    expect(output).toContain("[good](<https://two.test/>)");
    expect(output).not.toContain("https://one.test/prefix%20");
  });

  it("preserves meaningful closing brackets in URLs", () => {
    expect(formatDilMarkdown("urlItemhttps://example.com/items]")).toBe(
      "[Item](<https://example.com/items]>)",
    );
  });

  it("does not mistake escaped backticks for an inline-code boundary", () => {
    const source = "\\` escaped urlrealhttps://example.com \\` after";
    expect(formatDilMarkdown(source)).toContain("[real](<https://example.com/>)");
  });

  it("recognizes closing backticks preceded by literal backslashes within code", () => {
    const tick = String.fromCharCode(96);
    const source = [
      tick,
      "abc \\",
      tick,
      " urlOutsidehttps://good.test ",
      tick,
      "tail",
      tick,
    ].join("");
    expect(formatDilMarkdown(source)).toContain("[Outside](<https://good.test/>)");
  });

  it("avoids quadratic rescanning on 12,000 incomplete URL markers", () => {
    const incomplete = "urlbrokenhttps://a.test ".repeat(12_000);
    const started = performance.now();
    const output = formatDilMarkdown(incomplete);
    expect(output).toBe(incomplete);
    expect(performance.now() - started).toBeLessThan(1_100);
  });

  it("scans thousands of incomplete prefixes in bounded time", () => {
    const broken = "urlbrokenhttps://one.test ".repeat(2_000);
    const source = broken + "urlvalidhttps://two.test";
    const started = performance.now();
    const output = formatDilMarkdown(source);
    expect(output).toContain("[valid](<https://two.test/>)");
    expect(performance.now() - started).toBeLessThan(750);
  });
  it("exits unfinished quoted and list fences at their container boundary", () => {
    const marker = "urloutsidehttps://example.com";
    for (const opening of ["> ~~~xml\n> literal\n\n", "- ~~~xml\n  literal\n\n"]) {
      expect(formatDilMarkdown(opening + marker)).toContain("[outside](<https://example.com/>)");
    }
  });

  it("never treats a four-space fence as an opening or closing delimiter", () => {
    const literal = "urlliteralhttps://example.com";
    const real = "urlrealhttps://example.com";
    const source = ["~~~xml", "    ~~~", literal, "~~~", real].join("\n");
    const result = formatDilMarkdown(source);
    expect(result).toContain(literal);
    expect(result).toContain("[real](<https://example.com/>)");
    const indented = ["    ~~~xml", "    " + literal, "    ~~~", real].join("\n");
    expect(formatDilMarkdown(indented)).toContain(literal);
    expect(formatDilMarkdown(indented)).toContain("[real](<https://example.com/>)");
  });

  it("keeps URL markers in ordinary four-space-indented code literal", () => {
    const literal = "urlliteralhttps://example.com";
    expect(formatDilMarkdown("    " + literal + "\n\n" + literal)).toBe(
      "    " + literal + "\n\n[literal](<https://example.com/>)",
    );
  });

  it("handles many distinct unmatched backtick runs in near-linear time", () => {
    const input =
      Array.from({ length: 800 }, (_, i) => String.fromCharCode(96).repeat(i + 1)).join(" ") +
      "\nurlrealhttps://example.com";
    const start = performance.now();
    expect(formatDilMarkdown(input)).toContain("[real](<https://example.com/>)");
    expect(performance.now() - start).toBeLessThan(1_000);
  });
  it("does not treat literal blockquote markers inside a top-level fence as new containers", () => {
    const literal = "urlliteralhttps://example.com";
    const outside = "urloutsidehttps://example.com";
    const source = ["~~~xml", "> " + literal, "> <svg><circle r='1'/></svg>", "~~~", outside].join(
      "\n",
    );
    const output = formatDilMarkdown(source);
    expect(output).toContain("> " + literal);
    expect(output).toContain("[outside](<https://example.com/>)");
  });

  it("recognizes a fence on a continuation line and ends it at the list boundary", () => {
    const outside = "urloutsidehttps://example.com";
    const source = "- item\n  ~~~xml\n  literal\n\n" + outside;
    expect(formatDilMarkdown(source)).toContain("[outside](<https://example.com/>)");
  });

  it("converts links in paragraph continuation despite four-space indentation", () => {
    const marker = "urlcontinuedhttps://example.com";
    expect(formatDilMarkdown("Intro paragraph\n    " + marker)).toContain(
      "[continued](<https://example.com/>)",
    );
  });

  it("accepts tab-indented content within a list-nested fence", () => {
    const marker = "urloutsidehttps://example.com";
    const source = "- ~~~xml\n\tinside\n  ~~~\n" + marker;
    expect(formatDilMarkdown(source)).toContain("[outside](<https://example.com/>)");
  });

  it("keeps extra quote markers as literal content within a blockquoted fence", () => {
    const marker = "urlliteralhttps://example.com";
    const outside = "urloutsidehttps://example.com";
    const source = ["> ~~~xml", "> > " + marker, "> ~~~", outside].join("\n");
    const output = formatDilMarkdown(source);
    expect(output).toContain("> > " + marker);
    expect(output).toContain("[outside](<https://example.com/>)");
  });
  it("protects indented code after headings and thematic breaks without hiding prose continuations", () => {
    const literal = "urlliteralhttps://example.com";
    for (const prefix of ["# Heading", "---", "Heading\n===", "## More heading"]) {
      const source = prefix + "\n    " + literal + "\n\n" + literal;
      const output = formatDilMarkdown(source);
      expect(output).toContain("    " + literal);
      expect(output).toContain("[literal](<https://example.com/>)");
    }
    expect(formatDilMarkdown("Intro paragraph\n    " + literal)).toContain(
      "[literal](<https://example.com/>)",
    );
  });
});
