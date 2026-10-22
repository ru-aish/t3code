import { describe, expect, it } from "vite-plus/test";
import {
  markdownHtmlContent,
  markdownWithHtml,
  markdownWithStaticCards,
  parseMarkdownDocument,
} from "./markdownDocument";
import { markdownImageSources } from "./markdownImageSources";

describe("static ChatGPT cards in native Markdown", () => {
  const items = [
    { kind: "title", value: "Build status" },
    { kind: "badge", value: "Passed" },
    { kind: "text", value: "All checks passed" },
    { kind: "caption", value: "Verified today" },
  ];

  it("renders a server card fence as readable content in prose order", () => {
    const source = "Before\n\n```t3-card\n" + JSON.stringify({ items }) + "\n```\n\nAfter";
    const result = markdownWithStaticCards(source);
    expect(result).toContain("### Build status");
    expect(result).toContain("**Passed**");
    expect(result).toContain("All checks passed");
    expect(result).toContain("Verified today");
    expect(result).not.toContain("t3-card");
    expect(result.indexOf("Before")).toBeLessThan(result.indexOf("Build status"));
    expect(result.indexOf("After")).toBeGreaterThan(result.indexOf("Verified today"));
    expect(parseMarkdownDocument(result).children.some((node) => node.type === "heading")).toBe(
      true,
    );
  });

  it("keeps card text inert instead of enabling images, links or raw HTML", () => {
    const source =
      "````t3-card\n" +
      JSON.stringify({
        items: [
          {
            kind: "text",
            value: "See [link](https://example.org) ![image](bad.png) <img> **bold**",
          },
        ],
      }) +
      "\n````";
    const result = markdownWithStaticCards(source);
    expect(result).toContain("[link](https://example.org)");
    expect(result).toContain("![image](bad.png)");
    expect(result).toContain("<img>");
    const paragraph = parseMarkdownDocument(result).children.find(
      (node) => node.type === "paragraph",
    );
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type === "paragraph")
      expect(paragraph.children.map((node) => node.type)).toEqual(["inlineCode"]);
  });

  it("does not create GFM auto-links from card text", () => {
    const value = "Visit https://example.org, www.example.org or team@example.org";
    const source = "```t3-card\n" + JSON.stringify({ items: [{ kind: "text", value }] }) + "\n```";
    const result = markdownWithStaticCards(source);
    const paragraph = parseMarkdownDocument(result).children.find(
      (node) => node.type === "paragraph",
    );
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type === "paragraph") {
      expect(paragraph.children.some((node) => node.type === "link")).toBe(false);
      expect(paragraph.children.map((node) => ("value" in node ? node.value : "")).join("")).toBe(
        value,
      );
    }
  });

  it("keeps leading and trailing backticks inert around mobile card URLs", () => {
    for (const value of [
      "`![x](https://a.example/track.png)",
      "![x](https://a.example/track.png)`",
      "`[click](https://a.example)",
      "`https://a.example",
      "`name@example.org",
      "``![x](https://a.example/track.png)``",
    ]) {
      const source =
        "```t3-card\n" + JSON.stringify({ items: [{ kind: "text", value }] }) + "\n```";
      const result = markdownWithStaticCards(source);
      const paragraph = parseMarkdownDocument(result).children.find(
        (node) => node.type === "paragraph",
      );
      expect(paragraph?.type).toBe("paragraph");
      if (paragraph?.type === "paragraph") {
        expect(paragraph.children.map((node) => node.type)).toEqual(["inlineCode"]);
        expect(paragraph.children[0]).toMatchObject({ value });
      }
    }
  });

  it("decodes card HTML character references exactly once", () => {
    const value = "R&amp;D &copy; &lt;tag&gt; &#124; &#xA9; A & B &amp;copy;";
    const source = "```t3-card\n" + JSON.stringify({ items: [{ kind: "text", value }] }) + "\n```";
    const result = markdownWithStaticCards(source);
    const paragraph = parseMarkdownDocument(result).children.find(
      (node) => node.type === "paragraph",
    );
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type === "paragraph")
      expect(paragraph.children.map((node) => ("value" in node ? node.value : "")).join("")).toBe(
        "R&D © <tag> | © A & B &copy;",
      );
  });

  it("skips a full parse for incidental t3-card mentions without a root fence", () => {
    const plain = "Prose about t3-card with no fence.\n".repeat(3_000);
    expect(markdownWithStaticCards(plain)).toBe(plain);
    const tilde = "~~~t3-card\n" + JSON.stringify({ items }) + "\n~~~";
    expect(markdownWithStaticCards(tilde)).toContain("### Build status");
  });

  it("leaves unsupported, malformed and non-root card fences as source", () => {
    for (const source of [
      "```t3-card\nnot-json\n```",
      "```t3-card\n" + JSON.stringify({ items: [{ kind: "button", value: "Run" }] }) + "\n```",
      "```t3-card\n" +
        JSON.stringify({ items: [{ kind: "text", value: "x".repeat(601) }] }) +
        "\n```",
      "> ```t3-card\n> " + JSON.stringify({ items }) + "\n> ```",
      "Regular `t3-card` text",
    ]) {
      expect(markdownWithStaticCards(source)).toBe(source);
    }
  });
});

describe("HTML in native Markdown", () => {
  it("leaves code inside an HTML details block literal", () => {
    const content =
      '<details>\n<summary>Example</summary>\n\n```html\n<img src="literal.png">\n```\n\nUse `<img>` here.\n</details>';
    const result = markdownHtmlContent(content);
    expect(result).toContain('```html\n<img src="literal.png">\n```');
    expect(result).toContain("Use `<img>` here.");
    expect(result).not.toContain("<details>");
  });
  it("preserves screenshot URLs and captions from GitHub HTML image embeds", () => {
    expect(
      markdownHtmlContent(
        '<img width="900" alt="Before > after [settings]" src="https://example.com/before.png?a=1&amp;b=2" />',
      ),
    ).toBe("![Before > after \\[settings\\]](<https://example.com/before.png?a=1\\&b=2>)");
    expect(
      markdownHtmlContent(
        "<a href='https://example.com'><img src='https://example.com/banner.svg' alt='Review' /></a>",
      ),
    ).toBe("![Review](<https://example.com/banner.svg>)");
  });

  it("decodes HTML attributes once and preserves entity-shaped query values through Markdown", () => {
    const markdown =
      '<img alt="&amp;lt;" src="https://example.com/shot.png?label=&amp;lt;&amp;sig=a%26b">';
    expect(markdownWithHtml(markdown)).toBe(
      "![\\&lt;](<https://example.com/shot.png?label=\\&lt;\\&sig=a%26b>)",
    );
    expect(markdownImageSources(markdown)).toEqual([
      "https://example.com/shot.png?label=&lt;&sig=a%26b",
    ]);
    const paragraph = parseMarkdownDocument(markdown).children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type === "paragraph")
      expect(paragraph.children[0]).toMatchObject({ type: "image", alt: "&lt;" });
  });

  it("ignores code delimiters in HTML attributes and comments when collecting screenshots", () => {
    const markdown =
      '<details data-example="`">\n<summary>Proof</summary>\n<img src="https://example.com/shot.png" alt="Screenshot">\n<!-- ` -->\n</details>';
    expect(markdownHtmlContent(markdown)).toContain(
      "![Screenshot](<https://example.com/shot.png>)",
    );
    expect(markdownImageSources(markdown)).toEqual(["https://example.com/shot.png"]);
    expect(markdownWithHtml(markdown)).not.toContain("<img");
  });

  it("removes bot metadata and details wrappers while keeping the content", () => {
    const markdown =
      "<!-- generated bot metadata -->\n<details>\n<summary>Walkthrough</summary>\n\n## Changes\n\nText\n\n</details>";
    const result = markdownWithHtml(markdown);
    expect(result).not.toContain("<!--");
    expect(result).not.toContain("<details>");
    expect(result).toContain("**Walkthrough**");
    expect(result).toContain("## Changes");
    expect(parseMarkdownDocument(markdown).children.some((node) => node.type === "html")).toBe(
      false,
    );
  });

  it("collects HTML and Markdown screenshots while leaving inline and fenced code literal", () => {
    const markdown =
      '```html\n<img src="literal.png">\n```\n\nUse `<img src="inline.png">` here.\n\n<img src="one.png">\n\n![Two](two.png)\n\n<img src="one.png">';
    expect(markdownImageSources(markdown)).toEqual(["one.png", "two.png"]);
    const result = markdownWithHtml(markdown);
    expect(result).toContain('```html\n<img src="literal.png">\n```');
    expect(result).toContain('`<img src="inline.png">`');
  });
});
