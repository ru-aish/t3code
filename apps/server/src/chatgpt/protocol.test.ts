import { describe, expect, it } from "@effect/vitest";
import {
  imageUploadDestination,
  mergeFinalAnswer,
  normalizeProjects,
  normalizeStreamMessage,
} from "./protocol.ts";

describe("ChatGPT protocol", () => {
  it("keeps the complete final answer when hidden stream copies overlap", () => {
    const draft = "Introduction\n\n## Findings\nPart one.";
    const expanded = draft + "\n\n## Root cause\nFixed.";
    expect(mergeFinalAnswer(undefined, draft)).toBe(draft);
    expect(mergeFinalAnswer(draft, expanded)).toBe(expanded);
    expect(mergeFinalAnswer(expanded, "## Root cause\nFixed.")).toBe(expanded);
    expect(mergeFinalAnswer(expanded, "## Download\nNew AppImage.")).toBe(
      expanded + "\n\n## Download\nNew AppImage.",
    );
    expect(
      mergeFinalAnswer("Paragraph one.\n\nParagraph two.", "Paragraph two.\n\nParagraph three."),
    ).toBe("Paragraph one.\n\nParagraph two.\n\nParagraph three.");
  });

  it("retains the complete answer and recognizes the hidden ending copy", () => {
    const full =
      "First paragraph\n\n## Evidence\nThe findings are here.\n\n## Conclusion\nComplete.";
    const visible = normalizeStreamMessage({
      message: {
        id: "canonical",
        author: { role: "assistant" },
        channel: "final",
        content: { parts: [full] },
        metadata: { is_complete: true },
      },
    });
    const hidden = normalizeStreamMessage({
      message: {
        id: "ending",
        author: { role: "assistant" },
        channel: "final",
        content: { parts: ["## Conclusion\nComplete."] },
        metadata: { is_visually_hidden_from_conversation: true },
      },
    });
    expect(visible.text).toBe(full);
    expect(visible.hidden).toBe(false);
    expect(hidden.hidden).toBe(true);
    expect(
      normalizeStreamMessage({
        data: {
          message: {
            content: { parts: [] },
            metadata: { model_dil_v2: { fallbackMarkdown: full } },
          },
        },
      }).text,
    ).toBe(full);
  });
  it("uses a Markdown fallback instead of raw ChatGPT DIL when available", () => {
    const raw = `<box gap={2}><button onClick={()=>GenUI.openUrl("https://example.com/app")}>Download</button></box>`;
    expect(
      normalizeStreamMessage({
        message: {
          id: "full-ui",
          author: { role: "assistant" },
          channel: "final",
          content: { parts: [raw] },
          metadata: { model_dil_v2: { fallbackMarkdown: "[Download](https://example.com/app)" } },
        },
      }).text,
    ).toBe("[Download](https://example.com/app)");
  });

  it("preserves inline SVG illustrations for the safe Markdown preview", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle r="5"/></svg>';
    const normalized = normalizeStreamMessage({
      message: {
        author: { role: "assistant" },
        channel: "final",
        content: { parts: [`<box>${svg}</box>`] },
      },
    });
    expect(normalized.text).toContain(`\`\`\`svg\n${svg}\n\`\`\``);
    expect(normalized.text).not.toContain("<box>");
  });

  it("uses a longer fence when SVG content includes Markdown delimiters", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>```</text></svg>';
    const normalized = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [svg] } },
    });
    expect(normalized.text).toContain(`\`\`\`\`svg\n${svg}\n\`\`\`\``);
  });

  it("preserves nested SVG viewports as a complete illustration", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><svg x="2"><circle r="1"/></svg></svg>';
    const normalized = normalizeStreamMessage({
      message: {
        author: { role: "assistant" },
        channel: "final",
        content: { parts: [`<box>${svg}</box>`] },
      },
    });
    expect(normalized.text).toContain(`\`\`\`svg\n${svg}\n\`\`\``);
    expect(normalized.text).not.toContain("<box>");
    expect(normalized.text?.match(/<\/svg>/g)).toHaveLength(2);
  });

  it("handles quoted angle brackets in nested SVG tags", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><svg aria-label="a > b"><path d="M0 0"/></svg></svg>';
    const normalized = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [svg] } },
    });
    expect(normalized.text).toContain(`\`\`\`svg\n${svg}\n\`\`\``);
  });

  it("ignores closing SVG tokens in comments and CDATA", () => {
    for (const embedded of ["<!-- </svg> -->", "<![CDATA[</svg>]]>"]) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">${embedded}<circle r="1"/></svg>`;
      const output = normalizeStreamMessage({
        message: { author: { role: "assistant" }, channel: "final", content: { parts: [svg] } },
      }).text;
      expect(output).toContain(`\`\`\`svg\n${svg}\n\`\`\``);
    }
  });

  it("does not split SVG into Markdown sections at inline code fences", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>```hello```</text></svg>';
    const output = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [svg] } },
    }).text;
    expect(output).toContain(`\`\`\`\`svg\n${svg}\n\`\`\`\``);
  });

  it("retains literal SVG code fenced by the assistant", () => {
    const fenced = '```svg\n<svg><circle r="1"/></svg>\n```';
    const output = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [fenced] } },
    }).text;
    expect(output).toBe(fenced);
  });

  it("preserves DIL download buttons with inline-code labels through normalization", () => {
    const input = [
      "<box>",
      '<button onClick={()=>GenUI.openUrl("https://example.com/app")}>Download `App`</button>',
      "</box>",
    ].join("\n");
    const output = normalizeStreamMessage({
      message: {
        author: { role: "assistant" },
        channel: "final",
        content: { parts: [input] },
      },
    }).text;
    expect(output).toContain("[Download `App`](https://example.com/app)");
    expect(output).not.toContain("GenUI.openUrl");
    expect(output).not.toContain("</button>");
  });

  it("does not extract SVG inside single- and double-backtick inline code", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
    for (const ticks of ["`", "``"]) {
      const sample = "The literal is " + ticks + svg + ticks + ".";
      expect(
        normalizeStreamMessage({
          message: {
            author: { role: "assistant" },
            channel: "final",
            content: { parts: [sample] },
          },
        }).text,
      ).toBe(sample);
    }
  });

  it("preserves SVG examples inside blockquoted and list-nested fences", () => {
    const tick = String.fromCharCode(96).repeat(3);
    const samples = [
      ["> ~~~xml", '> <svg><circle r="1"/></svg>', "> ~~~"].join("\n"),
      ["- " + tick + "xml", '  <svg><circle r="1"/></svg>', "  " + tick].join("\n"),
      ["    ~~~xml", '    <svg><circle r="1"/></svg>', "    ~~~"].join("\n"),
      ["> > " + tick + "svg", '> > <svg><circle r="1"/></svg>', "> > " + tick].join("\n"),
    ];
    for (const sample of samples) {
      expect(
        normalizeStreamMessage({
          message: {
            author: { role: "assistant" },
            channel: "final",
            content: { parts: [sample] },
          },
        }).text,
      ).toBe(sample);
    }
  });

  it("retains Markdown-escaped SVG examples instead of promoting diagrams", () => {
    for (const sample of [
      'Literal: \\<svg><circle r="1"/></svg>.',
      'Nested: \\<svg><svg><circle r="1"/></svg></svg>.',
    ]) {
      expect(
        normalizeStreamMessage({
          message: {
            author: { role: "assistant" },
            channel: "final",
            content: { parts: [sample] },
          },
        }).text,
      ).toBe(sample);
    }
    const evenSlash = '\\\\<svg><circle r="1"/></svg>';
    expect(
      normalizeStreamMessage({
        message: {
          author: { role: "assistant" },
          channel: "final",
          content: { parts: [evenSlash] },
        },
      }).text,
    ).toContain(
      String.fromCharCode(96).repeat(3) +
        'svg\n<svg><circle r="1"/></svg>\n' +
        String.fromCharCode(96).repeat(3),
    );
  });

  it("leaves SVG examples in tilde fences untouched", () => {
    const sample = '~~~xml\n<svg><circle r="1"/></svg>\n~~~\nAfter.';
    expect(
      normalizeStreamMessage({
        message: { author: { role: "assistant" }, channel: "final", content: { parts: [sample] } },
      }).text,
    ).toBe(sample);
  });

  it("requires real fence-closing lines for four-backtick fences", () => {
    const sample = [
      "````js",
      'const delimiter = "```";',
      "<svg><circle r='1'/></svg>",
      "`````",
      "After.",
    ].join("\n");
    expect(
      normalizeStreamMessage({
        message: { author: { role: "assistant" }, channel: "final", content: { parts: [sample] } },
      }).text,
    ).toBe(sample);
  });

  it("preserves code then renders following SVG normally", () => {
    const code = "~~~xml\n<svg><circle r='1'/></svg>\n~~~";
    const svg = "<svg><circle r='2'/></svg>";
    const output = normalizeStreamMessage({
      message: {
        author: { role: "assistant" },
        channel: "final",
        content: { parts: [code + "\n\n" + svg] },
      },
    }).text;
    expect(output).toContain(code);
    expect(output).toContain("```svg\n" + svg + "\n```");
  });

  it("does not treat backslash before closing inline tick as an escape", () => {
    const tick = String.fromCharCode(96);
    const sample = [tick, "C:\\Users\\", tick, " <svg><circle r='1'/></svg>"].join("");
    const output = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [sample] } },
    }).text;
    expect(output).toContain(tick + "C:\\Users\\" + tick);
    expect(output).toContain("```svg\n<svg><circle r='1'/></svg>\n```");
  });

  it("supports self-closing SVG with whitespace", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" />';
    const output = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [svg] } },
    }).text;
    expect(output).toContain(`\`\`\`svg\n${svg}\n\`\`\``);
  });

  it("scans unclosed nested SVG in bounded time during streaming", () => {
    const unclosed = "<svg><svg>".repeat(2_000);
    const started = performance.now();
    const output = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [unclosed] } },
    }).text;
    expect(output).toBe(unclosed);
    expect(performance.now() - started).toBeLessThan(750);
  });

  it("preserves text following a completed SVG", () => {
    const svg = '<svg><circle r="1"/></svg>';
    const source = `<box>${svg}\nAfter image</box>`;
    const output = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [source] } },
    }).text;
    expect(output).toContain("After image");
    expect(output).toContain(`\`\`\`svg\n${svg}\n\`\`\``);
  });

  it("degrades a final DIL component into readable Markdown when no fallback exists", () => {
    const rich = [
      "## Ready",
      "<box gap={2}>",
      '<row gap={1}><icon name="check-circle"/> **Build passed**</row>',
      '<button block onClick={()=>GenUI.openUrl("https://example.com/artifact")}>Download AppImage</button>',
      "</box>",
    ].join("\n");
    const normalized = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [rich] } },
    }).text;
    expect(normalized).toContain("## Ready");
    expect(normalized).toContain("**Build passed**");
    expect(normalized).toContain("[Download AppImage](https://example.com/artifact)");
    expect(normalized).not.toContain("<box");
    expect(normalized).not.toContain("GenUI.openUrl");
    const nestedButton = normalizeStreamMessage({
      message: {
        author: { role: "assistant" },
        channel: "final",
        content: {
          parts: [
            '<box><button onClick={()=>GenUI.openUrl("https://example.com/archive")}><icon name="download" />Download ZIP</button></box>',
          ],
        },
      },
    }).text;
    expect(nestedButton).toContain("[Download ZIP](https://example.com/archive)");
    const codeSample = "```jsx\n<box gap={2}><row>Example</row></box>\n```";
    expect(
      normalizeStreamMessage({
        message: {
          author: { role: "assistant" },
          channel: "final",
          content: { parts: [codeSample] },
        },
      }).text,
    ).toBe(codeSample);
  });

  it("lists cloud projects while excluding archived projects and custom GPTs", () => {
    const raw = {
      items: [
        { gizmo: { gizmo: { id: "g-p-one", display: { name: "Cloud project" } } } },
        { gizmo: { gizmo: { id: "g-custom", display: { name: "A custom GPT" } } } },
        { gizmo: { gizmo: { id: "g-p-old", display: { name: "Archived" }, is_archived: true } } },
      ],
    };
    expect(normalizeProjects(raw)).toEqual([{ id: "g-p-one", name: "Cloud project" }]);
  });
  it("uploads to Azure behind OpenAI domains and to signed AWS destinations", () => {
    const azure = imageUploadDestination(
      "https://sdmntprindiasocentral.oaiusercontent.com/file?sig=example",
      "image/png",
    );
    expect(azure.headers["x-ms-blob-type"]).toBe("BlockBlob");
    const aws = imageUploadDestination(
      "https://bucket.s3.amazonaws.com/file?X-Amz-Algorithm=AWS4-HMAC-SHA256",
      "image/jpeg",
    );
    expect(aws.headers["x-ms-blob-type"]).toBeUndefined();
    const embedded = imageUploadDestination(
      "https://chatgpt.com/estuary/upload?upload_url=" + encodeURIComponent(azure.url.href),
      "image/png",
    );
    expect(embedded.url.href).toBe(azure.url.href);
    expect(() => imageUploadDestination("http://localhost/file", "image/png")).toThrow("HTTPS");
  });
  it("extracts SVG after a nested fence container ends", () => {
    const svg = '<svg><circle r="1"/></svg>';
    for (const prefix of ["> ~~~xml\n> literal\n\n", "- ~~~xml\n  literal\n\n"]) {
      const input = prefix + svg;
      const output = normalizeStreamMessage({
        message: { author: { role: "assistant" }, channel: "final", content: { parts: [input] } },
      }).text;
      expect(output).toContain("```svg\n" + svg + "\n```".replaceAll("`", String.fromCharCode(96)));
    }
  });

  it("respects fence indentation when extracting SVG", () => {
    const svg = '<svg><circle r="1"/></svg>';
    const input = ["~~~xml", "    ~~~", svg, "~~~", svg].join("\n");
    const output = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [input] } },
    }).text;
    expect(output).toContain("    ~~~\n" + svg + "\n~~~");
    expect((output ?? "").split("```svg".replaceAll("`", String.fromCharCode(96)))).toHaveLength(2);
    const indented = "    ~~~xml\n    " + svg + "\n    ~~~\n" + svg;
    const result = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [indented] } },
    }).text;
    expect(result).toContain("    " + svg);
    expect((result ?? "").split("```svg".replaceAll("`", String.fromCharCode(96)))).toHaveLength(2);
  });

  it("does not promote four-space-indented SVG code to a diagram", () => {
    const svg = '<svg><circle r="1"/></svg>';
    const source = "    " + svg + "\n\n" + svg;
    const output = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [source] } },
    }).text;
    expect(output).toContain("    " + svg);
    expect((output ?? "").split("```svg".replaceAll("`", String.fromCharCode(96)))).toHaveLength(2);
  });
  it("does not extract SVG after literal quote characters in a top-level fence", () => {
    const svg = '<svg><circle r="1"/></svg>';
    const input = ["~~~xml", "> " + svg, "~~~"].join("\n");
    expect(
      normalizeStreamMessage({
        message: { author: { role: "assistant" }, channel: "final", content: { parts: [input] } },
      }).text,
    ).toBe(input);
  });

  it("extracts SVG after an unfinished list-continuation fence ends", () => {
    const svg = '<svg><circle r="1"/></svg>';
    const input = "- item\n  ~~~xml\n  literal\n\n" + svg;
    expect(
      normalizeStreamMessage({
        message: { author: { role: "assistant" }, channel: "final", content: { parts: [input] } },
      }).text,
    ).toContain("```svg\n" + svg + "\n```");
  });

  it("does not mistake SVG in an indented paragraph continuation for code", () => {
    const svg = '<svg><circle r="1"/></svg>';
    const input = "Intro paragraph\n    " + svg;
    expect(
      normalizeStreamMessage({
        message: { author: { role: "assistant" }, channel: "final", content: { parts: [input] } },
      }).text,
    ).toContain("```svg\n" + svg + "\n```");
  });

  it("preserves tab-indented list fence content and extracts following SVG", () => {
    const svg = '<svg><circle r="1"/></svg>';
    const input = "- ~~~xml\n\tinside\n  ~~~\n" + svg;
    expect(
      normalizeStreamMessage({
        message: { author: { role: "assistant" }, channel: "final", content: { parts: [input] } },
      }).text,
    ).toContain("```svg\n" + svg + "\n```");
  });

  it("preserves literal nested quote markers as fenced SVG code", () => {
    const svg = '<svg><circle r="1"/></svg>';
    const input = ["> ~~~xml", "> > " + svg, "> ~~~"].join("\n");
    expect(
      normalizeStreamMessage({
        message: { author: { role: "assistant" }, channel: "final", content: { parts: [input] } },
      }).text,
    ).toBe(input);
  });
  it("promotes SVG following lazy equals lines but protects it after a real heading", () => {
    const svg = '<svg><circle r="1"/></svg>';
    for (const lazy of ["=", "==", "===", "====="]) {
      const source = "> text\n" + lazy + "\n>     " + svg;
      const output =
        normalizeStreamMessage({
          message: {
            author: { role: "assistant" },
            channel: "final",
            content: { parts: [source] },
          },
        }).text ?? "";
      expect(output).toContain("```svg\n" + svg + "\n```");
    }
    for (const prefix of ["> text\n> ===\n>     ", "Paragraph\n===\n    "]) {
      const source = prefix + svg;
      const output =
        normalizeStreamMessage({
          message: {
            author: { role: "assistant" },
            channel: "final",
            content: { parts: [source] },
          },
        }).text ?? "";
      expect(output).toContain(prefix + svg);
      expect(output).not.toContain("```svg");
    }
  });

  it("recognizes SVG after explicit quote markers resume following lazy paragraph lines", () => {
    const svg = '<svg><circle r="1"/></svg>';
    for (const prefix of [
      "> text\ncontinued\n>     ",
      "> text\ncontinued\ncontinued again\n>     ",
      "> text\n    continued\n>     ",
    ]) {
      const output =
        normalizeStreamMessage({
          message: {
            author: { role: "assistant" },
            channel: "final",
            content: { parts: [prefix + svg] },
          },
        }).text ?? "";
      expect(output).toContain("```svg\n" + svg + "\n```");
    }
    const terminated = "> text\ncontinued\n\n>     " + svg;
    const output =
      normalizeStreamMessage({
        message: {
          author: { role: "assistant" },
          channel: "final",
          content: { parts: [terminated] },
        },
      }).text ?? "";
    expect(output).toContain(">     " + svg);
    expect(output).not.toContain("```svg");
  });

  it("promotes SVG in lazy quoted paragraph continuations, not indented code blocks", () => {
    const svg = '<svg><circle r="1"/></svg>';
    for (const input of ["> text\n    " + svg, "> text\n    " + svg + "\n    " + svg]) {
      const output =
        normalizeStreamMessage({
          message: { author: { role: "assistant" }, channel: "final", content: { parts: [input] } },
        }).text ?? "";
      expect(output).toContain("```svg\n" + svg + "\n```");
    }
    const code = "> text\n\n    " + svg + "\n\n" + svg;
    const output =
      normalizeStreamMessage({
        message: { author: { role: "assistant" }, channel: "final", content: { parts: [code] } },
      }).text ?? "";
    expect(output).toContain("    " + svg);
    expect(output.split("```svg")).toHaveLength(2);
  });

  it("does not promote SVG in indented code after entering a blockquote", () => {
    const svg = '<svg><circle r="1"/></svg>';
    const source = "Paragraph\n>     " + svg + "\n\n" + svg;
    const output =
      normalizeStreamMessage({
        message: { author: { role: "assistant" }, channel: "final", content: { parts: [source] } },
      }).text ?? "";
    expect(output).toContain(">     " + svg);
    expect(output.split("```svg")).toHaveLength(2);
  });

  it("protects SVG after spaced thematic breaks before generating a standalone preview", () => {
    const svg = '<svg><circle r="1"/></svg>';
    for (const rule of ["- - -", "* * *", "-  -  -", "_ _ _"]) {
      const source = rule + "\n    " + svg + "\n\n" + svg;
      const output =
        normalizeStreamMessage({
          message: {
            author: { role: "assistant" },
            channel: "final",
            content: { parts: [source] },
          },
        }).text ?? "";
      expect(output).toContain("    " + svg);
      expect(output.split("```svg")).toHaveLength(2);
    }
  });

  it("keeps SVG inside code blocks after headings and rules while preserving later previews", () => {
    const svg = '<svg><circle r="1"/></svg>';
    for (const prefix of ["# Heading", "---", "Heading\n===", "## More heading"]) {
      const source = prefix + "\n    " + svg + "\n\n" + svg;
      const output =
        normalizeStreamMessage({
          message: {
            author: { role: "assistant" },
            channel: "final",
            content: { parts: [source] },
          },
        }).text ?? "";
      expect(output).toContain("    " + svg);
      expect(output.split("```svg")).toHaveLength(2);
    }
  });
});

describe("ChatGPT rich chart preservation", () => {
  const chart = {
    chartType: "bar",
    xKey: "month",
    series: [{ dataKey: "sales", label: "Sales" }],
    data: [
      { month: "Jan", sales: 10 },
      { month: "Feb", sales: 20 },
    ],
  };
  const source = `<box><Chart content={${JSON.stringify(chart)}} /></box>`;
  const normalize = (content: string, fallback?: string) =>
    normalizeStreamMessage({
      message: {
        author: { role: "assistant" },
        channel: "final",
        content: { parts: [content] },
        ...(fallback === undefined
          ? {}
          : { metadata: { model_dil_v2: { fallbackMarkdown: fallback } } }),
      },
    }).text;

  it("keeps chart data with a Markdown fallback and never leaks DIL source", () => {
    const result = normalize(source, "Monthly sales");
    expect(result).toContain("Monthly sales");
    expect(result).toContain(`\`\`\`t3-chart\n${JSON.stringify(chart)}\n\`\`\``);
    expect(result).not.toContain("<Chart");
  });

  it("renders a chart without Markdown fallback using inert fenced JSON", () => {
    const result = normalize(source);
    expect(result).not.toContain("<Chart");
    expect(result).toContain("t3-chart");
    expect(result).toContain('"chartType":"bar"');
  });

  it("ignores chart-like text inside code, escaped markup, and malformed data", () => {
    expect(normalize(`\`\`\`jsx\n${source}\n\`\`\``, "Plain")).toBe("Plain");
    expect(normalize(`\`${source}\``, "Plain")).toBe("Plain");
    expect(normalize(`\\<Chart content={${JSON.stringify(chart)}} />`, "Plain")).toBe("Plain");
    expect(normalize("<Chart content={dangerousExpression()} />", "Plain")).toBe("Plain");
    expect(normalize('<Chart content={{"chartType":"bar","data":[]}}', "Plain")).toBe("Plain");
  });

  it("keeps inline charts where they appeared in the answer, not at the end", () => {
    const content = `Before the chart.\n<Chart content={${JSON.stringify(chart)}} />\nAfter the chart.`;
    const result = normalize(content) ?? "";
    expect(result.indexOf("Before the chart.")).toBeLessThan(result.indexOf("```t3-chart"));
    expect(result.indexOf("```t3-chart")).toBeLessThan(result.indexOf("After the chart."));
    expect(result.split("```t3-chart")).toHaveLength(2);
  });

  it("anchors charts beside matching fallback prose when both are available", () => {
    const content = `Monthly sales rose steadily.\n<Chart content={${JSON.stringify(chart)}} />\nOur outlook remains positive.`;
    const result =
      normalize(content, "Monthly sales rose steadily.\n\nOur outlook remains positive.") ?? "";
    expect(result.indexOf("Monthly sales rose steadily.")).toBeLessThan(
      result.indexOf("```t3-chart"),
    );
    expect(result.indexOf("```t3-chart")).toBeLessThan(
      result.indexOf("Our outlook remains positive."),
    );
  });

  it("does not preview chart-looking markup in literal DIL blocks or HTML comments", () => {
    const literal = `<Chart content={${JSON.stringify(chart)}} />`;
    for (const content of [
      `<CodeBlock language="jsx">${literal}</CodeBlock>`,
      `<escape>${literal}</escape>`,
      `<!-- ${literal} -->`,
      `<WritingBlock variant="document">${literal}</WritingBlock>`,
      `<AppBlock>${literal}</AppBlock>`,
      `<CodeBlock>${literal}`,
      `<!-- ${literal}`,
    ]) {
      expect(normalize(content, "A plain text example.")).toBe("A plain text example.");
    }
    expect(normalize(`<CodeBlock>Example</CodeBlock>\n${literal}`, "A real chart")).toContain(
      "```t3-chart",
    );
  });

  it("does not let a fenced HTML-comment example hide a real chart", () => {
    const real = `<Chart content={${JSON.stringify(chart)}} />`;
    const content = `\`\`\`html\n<!--\n\`\`\`\n\nHere is the real chart.\n${real}`;
    const result = normalize(content, "Here is the real chart.") ?? "";
    expect(result).toContain("Here is the real chart.");
    expect(result).toContain("```t3-chart");
  });

  it("does not anchor fallback charts inside fenced or inline code", () => {
    const content = `Monthly sales rose steadily.\n<Chart content={${JSON.stringify(chart)}} />`;
    for (const fallback of [
      "```text\nMonthly sales rose steadily.\n```\n\nMonthly sales rose steadily.\nOur outlook remains positive.",
      "`Monthly sales rose steadily.`\n\nMonthly sales rose steadily.\nOur outlook remains positive.",
    ]) {
      const result = normalize(content, fallback) ?? "";
      expect(result.indexOf("```t3-chart")).toBeGreaterThan(
        result.lastIndexOf("Monthly sales rose steadily."),
      );
      expect(result.indexOf("```t3-chart")).toBeLessThan(
        result.indexOf("Our outlook remains positive."),
      );
    }
  });

  it("does not insert a chart within a Markdown link label or image alt text", () => {
    const content = `Monthly sales rose steadily.\n<Chart content={${JSON.stringify(chart)}} />`;
    for (const rich of [
      "[Monthly sales rose steadily.](https://example.com)",
      "![Monthly sales rose steadily.](https://example.com/chart.png)",
      "[Monthly sales rose steadily.][monthly]",
      "![Monthly sales rose steadily.][monthly]",
    ]) {
      const fallback = `${rich}\n\nMonthly sales rose steadily.\nOur outlook remains positive.`;
      const result = normalize(content, fallback) ?? "";
      expect(result).toContain(rich);
      expect(result.indexOf(rich)).toBeLessThan(result.indexOf("```t3-chart"));
      expect(result.indexOf("```t3-chart")).toBeGreaterThan(
        result.lastIndexOf("Monthly sales rose steadily."),
      );
      expect(result.indexOf("```t3-chart")).toBeLessThan(
        result.indexOf("Our outlook remains positive."),
      );
    }
  });

  it("appends after intact Markdown nodes when no standalone anchor exists", () => {
    const content = `Monthly sales rose steadily.\n<Chart content={${JSON.stringify(chart)}} />`;
    for (const fallback of [
      "[Monthly sales rose steadily.](https://example.com)",
      "![Monthly sales rose steadily.](https://example.com/chart.png)",
      "**Monthly sales rose steadily.**",
      "[Monthly sales rose steadily.][monthly]",
    ]) {
      const result = normalize(content, fallback) ?? "";
      expect(result.startsWith(fallback)).toBe(true);
      expect(result.indexOf("```t3-chart")).toBeGreaterThan(fallback.length);
      expect(result.split("```t3-chart")).toHaveLength(2);
    }
  });

  it("preserves a setext heading and ignores matching prose inside HTML comments", () => {
    const content = `Monthly sales rose steadily.\n<Chart content={${JSON.stringify(chart)}} />`;
    const fallback =
      "<!--\nMonthly sales rose steadily.\n-->\n\nMonthly sales rose steadily.\n====\n\nMonthly sales rose steadily.\nOur outlook remains positive.";
    const result = normalize(content, fallback) ?? "";
    expect(result).toContain("Monthly sales rose steadily.\n====");
    expect(result.indexOf("```t3-chart")).toBeGreaterThan(
      result.lastIndexOf("Monthly sales rose steadily."),
    );
    expect(result.indexOf("```t3-chart")).toBeLessThan(
      result.indexOf("Our outlook remains positive."),
    );
  });

  it("keeps multiline Markdown links and images intact while anchoring later prose", () => {
    const content = `Monthly sales rose steadily.\n<Chart content={${JSON.stringify(chart)}} />`;
    for (const rich of [
      "[\nMonthly sales rose steadily.\n](https://example.com)",
      "![\nMonthly sales rose steadily.\n](https://example.com/chart.png)",
      "[\nMonthly sales rose steadily.\n][monthly]",
      "![\nMonthly sales rose steadily.\n][monthly]",
    ]) {
      const fallback = `${rich}\n\nMonthly sales rose steadily.\nOutlook.`;
      const result = normalize(content, fallback) ?? "";
      expect(result).toContain(rich);
      expect(result.indexOf("```t3-chart")).toBeGreaterThan(
        result.lastIndexOf("Monthly sales rose steadily."),
      );
      expect(result.indexOf("```t3-chart")).toBeLessThan(result.indexOf("Outlook."));
    }
  });

  it("recognizes real HTML comments after a fenced literal comment opener", () => {
    const content = `Monthly sales rose steadily.\n<Chart content={${JSON.stringify(chart)}} />`;
    const fallback =
      "```html\n<!--\n```\n\n<!--\nMonthly sales rose steadily.\n-->\n\nMonthly sales rose steadily.\nOutlook.";
    const result = normalize(content, fallback) ?? "";
    expect(result).toContain("<!--\nMonthly sales rose steadily.\n-->");
    expect(result.indexOf("```t3-chart")).toBeGreaterThan(
      result.lastIndexOf("Monthly sales rose steadily."),
    );
    expect(result.indexOf("```t3-chart")).toBeLessThan(result.indexOf("Outlook."));
  });

  it("preserves setext headings with one to three spaces of underline indentation", () => {
    const content = `Monthly sales rose steadily.\n<Chart content={${JSON.stringify(chart)}} />`;
    for (const indentation of [" ", "  ", "   "]) {
      for (const underline of ["===", "---"]) {
        const heading = `Monthly sales rose steadily.\n${indentation}${underline}`;
        const fallback = `${heading}\n\nMonthly sales rose steadily.\nOutlook.`;
        const result = normalize(content, fallback) ?? "";
        expect(result).toContain(heading);
        expect(result.indexOf("```t3-chart")).toBeGreaterThan(
          result.lastIndexOf("Monthly sales rose steadily."),
        );
        expect(result.indexOf("```t3-chart")).toBeLessThan(result.indexOf("Outlook."));
      }
    }
  });

  it("does not treat comment-shaped strings inside chart data as real comments", () => {
    const data = {
      ...chart,
      data: [{ month: "<!-- unclosed literal comment", sales: 10 }],
    };
    const content = `<Chart content={${JSON.stringify(data)}} />`;
    expect(normalize(content, "Data chart")).toContain("```t3-chart");
    const next = `<Chart content={${JSON.stringify(chart)}} />`;
    expect(normalize(content + "\n" + next, "Charts")).toContain(
      `\`\`\`t3-chart\n${JSON.stringify(chart)}`,
    );
  });

  it("keeps extraction correct across thousands of literal raw blocks", () => {
    const literals = "<CodeBlock>not a chart</CodeBlock>\n".repeat(8_000);
    const result = normalize(literals + `<Chart content={${JSON.stringify(chart)}} />`, "Chart");
    expect(result?.split("```t3-chart")).toHaveLength(2);
  });

  it("retains complete snapshots during partial final streaming", () => {
    expect(normalize(source.slice(0, source.indexOf("/>")), "Fallback")).toBe("Fallback");
    expect(normalize(source, "Fallback")).toContain("t3-chart");
  });
});

describe("ChatGPT static DIL table preservation", () => {
  const source =
    "<table><table-row header><table-cell>Month</table-cell><table-cell>Sales</table-cell></table-row>" +
    "<table-row><table-cell>January</table-cell><table-cell>120</table-cell></table-row>" +
    "<table-row><table-cell>February</table-cell><table-cell>250</table-cell></table-row></table>";
  const normalize = (content: string, fallback?: string) =>
    normalizeStreamMessage({
      message: {
        author: { role: "assistant" },
        channel: "final",
        content: { parts: [content] },
        ...(fallback === undefined
          ? {}
          : { metadata: { model_dil_v2: { fallbackMarkdown: fallback } } }),
      },
    }).text ?? "";

  it("preserves static table columns and rows as GFM Markdown", () => {
    const result = normalize(`<box>Before.\n${source}\nAfter.</box>`);
    expect(result).toContain(
      "| Month | Sales |\n| --- | --- |\n| January | 120 |\n| February | 250 |",
    );
    expect(result).not.toContain("<table");
    expect(result.indexOf("Before.")).toBeLessThan(result.indexOf("| Month"));
    expect(result.indexOf("After.")).toBeGreaterThan(result.indexOf("| February"));
  });

  it("uses the official Markdown fallback without duplicating tables", () => {
    const fallback = "| Month | Sales |\n| --- | --- |\n| January | 120 |";
    expect(normalize(source, fallback)).toBe(fallback);
  });

  it("escapes Markdown-special text and HTML-looking entities in cells", () => {
    const table =
      "<table><table-row header><table-cell>Name</table-cell><table-cell>Value</table-cell></table-row>" +
      "<table-row><table-cell>x | y</table-cell><table-cell>[link](javascript:bad) &amp; *bold*</table-cell></table-row></table>";
    const result = normalize(table);
    expect(result).toContain("x \\| y");
    expect(result).toContain("\\[link\\]\\(javascript:bad\\)");
    expect(result).toContain("&amp;");
    expect(result).not.toContain("&amp;amp;");
    expect(result).toContain("\\*bold\\*");
  });

  it("does not promote data rows into headers or relocate later headers", () => {
    const noHeader = source.replace("<table-row header>", "<table-row>");
    const laterHeader = source
      .replace("<table-row header>", "<table-row>")
      .replace("<table-row><table-cell>January", "<table-row header><table-cell>January");
    const doubleHeader = source.replace(
      "<table-row><table-cell>January",
      "<table-row header><table-cell>January",
    );
    for (const invalid of [noHeader, laterHeader, doubleHeader]) {
      const result = normalize(invalid);
      expect(result).not.toContain("| Month | Sales |");
      expect(result).toContain("<table");
    }
    expect(normalize(source)).toContain("| Month | Sales |");
  });

  it("rejects rowSpan, colSpan, and unsupported structural cell properties", () => {
    for (const attribute of ["rowSpan=2", "colSpan=2", 'rowSpan="2"', "header", "align=right"]) {
      const invalid = source.replace("<table-cell>January", `<table-cell ${attribute}>January`);
      const result = normalize(invalid);
      expect(result).not.toContain("| Month | Sales |");
      expect(result).toContain("<table-cell");
    }
  });

  it("preserves decoded literal HTML entities without double-encoding or executing markup", () => {
    const text =
      "Research &amp; Development, &lt;script&gt; &quot;Hi&quot; &#124; &#x3C; &apos; &#39;";
    const table = `<table><table-row header><table-cell>Company</table-cell></table-row><table-row><table-cell>${text}</table-cell></table-row></table>`;
    const result = normalize(table);
    expect(result).toContain("Research &amp; Development");
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&quot;Hi&quot;");
    expect(result).toContain("&#124;");
    expect(result).not.toContain("&amp;amp;");
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("&amp;lt;");
  });

  it("does not move tables out of quoted, listed, or indented Markdown containers", () => {
    for (const container of [
      `> Quote before\n> ${source}\n> Quote after`,
      `- List item\n  ${source}\n  More list content`,
      `1. List item\n   ${source}`,
      `    ${source}`,
      `Text ${source} more text`,
    ]) {
      const output = normalize(container);
      expect(output).not.toContain("| Month | Sales |");
      expect(output).toContain("<table>");
    }
    expect(normalize(`Intro\n${source}\nOutro`)).toContain("| Month | Sales |");
  });

  it("keeps nested tables intact when outer DIL attributes contain angle brackets", () => {
    const inner = source.replaceAll("Month", "Inner");
    for (const attribute of [
      'emptyLabel="<no data>"',
      'emptyLabel="a > b < c"',
      "emptyLabel='<missing>'",
    ]) {
      const outer =
        `<table ${attribute}><table-row header><table-cell>Outer</table-cell></table-row>` +
        `<table-row><table-cell>${inner}</table-cell></table-row></table>`;
      const output = normalize(outer + "\n" + source);
      expect(output).not.toContain("| Inner | Sales |");
      expect(output).toContain("| Month | Sales |");
    }
  });

  it("bounds malformed raw component scans and does not expose nested tables", () => {
    const malformed = "<CodeBlock foo ".repeat(4_000);
    const output = normalize(malformed + source);
    expect(output).not.toContain("| Month | Sales |");
    expect(output).toContain("<CodeBlock");
    expect(normalize("<CodeBlock data-test='x > y'>" + source + "</CodeBlock>")).not.toContain(
      "| Month | Sales |",
    );
    expect(normalize("<CodeBlock>literal</CodeBlock>\n" + source)).toContain("| Month | Sales |");
  });

  it("never promotes a nested table inside unsupported outer table markup", () => {
    const inner = source.replaceAll("Month", "Inner");
    const outer = `<table><table-row header><table-cell>Outer</table-cell></table-row><table-row><table-cell>${inner}</table-cell></table-row></table>`;
    const output = normalize(outer);
    expect(output).not.toContain("| Inner | Sales |");
    expect(output).not.toContain("| Outer |");
    expect(output).toContain("<table");
    // A complete later sibling must still be independently converted.
    const sibling = normalize(`${outer}\n${source}`);
    expect(sibling).not.toContain("| Inner | Sales |");
    expect(sibling).toContain("| Month | Sales |");
    // Even an unclosed outer wrapper cannot independently promote descendants.
    const unclosed = normalize(`<table><table-row><table-cell>${inner}</table-cell>`);
    expect(unclosed).not.toContain("| Inner | Sales |");
  });

  it("preserves the complete named entity range without decoding entity text twice", () => {
    const entityText =
      "Copyright &copy; Registered &reg; Dash &mdash; Euro &euro; NotEqual &ne;" +
      " Double-escaped &amp;copy; Unknown &unknown; Numeric &#124; Hex &#xA9; Raw A & B";
    const content = `<table><table-row header><table-cell>Entities</table-cell></table-row><table-row><table-cell>${entityText}</table-cell></table-row></table>`;
    const result = normalize(content);
    expect(result).toContain("&copy;");
    expect(result).toContain("&reg;");
    expect(result).toContain("&mdash;");
    expect(result).toContain("&euro;");
    expect(result).toContain("&ne;");
    expect(result).toContain("&amp;copy;");
    expect(result).toContain("&unknown;");
    expect(result).toContain("&#124;");
    expect(result).toContain("&#xA9;");
    expect(result).toContain("A &amp; B");
    expect(result).not.toContain("&amp;copy; Registered");
    expect(result).not.toContain("&amp;amp;copy;");
  });

  it("skips tables embedded in fenced, inline, or raw code and HTML comments", () => {
    for (const literal of [
      `\`\`\`xml\n${source}\n\`\`\``,
      `\`${source}\``,
      `<CodeBlock>${source}</CodeBlock>`,
      `<escape>${source}</escape>`,
      `<AppBlock>${source}</AppBlock>`,
      `<!-- ${source} -->`,
      `\\${source}`,
    ]) {
      expect(normalize(literal)).not.toContain("| Month | Sales |");
    }
    expect(normalize(`<CodeBlock>example</CodeBlock>\n${source}`)).toContain("| Month | Sales |");
    expect(normalize(`\`\`\`xml\n<!--\n\`\`\`\n${source}`)).toContain("| Month | Sales |");
  });

  it("does not convert incomplete, dynamic, or unsupported tables", () => {
    for (const table of [
      source.slice(0, -8),
      source.replace("120", "{value}"),
      source.replace("<table-row>", "<table-row onClick={alert(1)}>"),
      source.replace(
        "<table-row>",
        "<table-row><table-cell>Unexpected</table-cell></table-row><table-row>",
      ),
      source.replace(
        "<table-cell>120</table-cell>",
        "<table-cell><button>Execute</button></table-cell>",
      ),
      source.replace("<table-row header>", "<table-section><table-row header>"),
      source.repeat(5_000),
    ]) {
      expect(normalize(table)).not.toContain("| Month | Sales |");
    }
  });

  it("keeps multiple complete tables and existing charts in their original order", () => {
    const chart = { chartType: "bar", series: [{ dataKey: "y" }], data: [{ x: "A", y: 1 }] };
    const result = normalize(
      `Before\n${source}\nMiddle\n<Chart content={${JSON.stringify(chart)}} />\n${source}\nAfter`,
    );
    expect(result.split("| Month | Sales |")).toHaveLength(3);
    expect(result.indexOf("```t3-chart")).toBeGreaterThan(result.indexOf("Middle"));
    expect(result.lastIndexOf("| Month | Sales |")).toBeGreaterThan(result.indexOf("```t3-chart"));
    expect(result.indexOf("After")).toBeGreaterThan(result.lastIndexOf("| Month | Sales |"));
  });
});

describe("ChatGPT bounded static DIL card preservation", () => {
  const card =
    "<card><title>Build status</title><badge>Passed</badge><text>All checks passed</text><caption>Verified today</caption></card>";
  const normalize = (content: string, fallback?: string) =>
    normalizeStreamMessage({
      message: {
        author: { role: "assistant" },
        channel: "final",
        content: { parts: [content] },
        ...(fallback === undefined
          ? {}
          : { metadata: { model_dil_v2: { fallbackMarkdown: fallback } } }),
      },
    }).text ?? "";

  it("preserves a complete static card in original prose order", () => {
    const output = normalize(`Before\n${card}\nAfter`);
    expect(output).toContain("```t3-card\n");
    expect(output).toContain('"kind":"title","value":"Build status"');
    expect(output).not.toContain("<card>");
    expect(output.indexOf("Before")).toBeLessThan(output.indexOf("t3-card"));
    expect(output.indexOf("After")).toBeGreaterThan(output.indexOf('"Verified today"'));
  });

  it("does not duplicate cards from the official fallback", () => {
    const output = normalize(card, "Build status: all checks passed.");
    expect(output).toBe("Build status: all checks passed.");
  });

  it("preserves fenced and inline code, comments and raw application blocks", () => {
    for (const content of [
      "```xml\n" + card + "\n```",
      "`" + card + "`",
      "<!--\n" + card + "\n-->",
      '<AppBlock language="html">\n' + card + "\n</AppBlock>",
      '<CodeBlock language="xml">\n' + card + "\n</CodeBlock>",
    ]) {
      expect(normalize(content)).not.toContain("t3-card");
    }
  });

  it("rejects unsupported props, nesting, dynamic and malformed cards", () => {
    for (const content of [
      "<card padding={3}><title>Hello</title></card>",
      "<card><title>{danger()}</title></card>",
      "<card><title>A</title><card><title>B</title></card></card>",
      "<card><title>Unclosed",
      "<card><text>Hello</text><button onClick={()=>evil()}>Act</button></card>",
      "> <card><title>Quoted</title></card>",
      "- <card><title>Nested list</title></card>",
    ]) {
      expect(normalize(content)).not.toContain("t3-card");
    }
  });

  it("chooses a safe fence when a card contains backtick runs", () => {
    const output = normalize("<card><title>Command ``` copy</title></card>");
    expect(output).toContain("````t3-card\n");
  });

  it("does not promote a complete card inside an unclosed outer card", () => {
    const output = normalize("<card>missing closing\n" + card);
    expect(output).not.toContain("t3-card");
  });

  it("does not promote nested cards inside unsupported outer card markup", () => {
    for (const outer of [
      "<card padding={3}>\n" + card + "\n</card>",
      '<card label="quoted > and < markup">\n' + card + "\n</card>",
      "<card>\n" + card + "\n</card>",
    ]) {
      expect(normalize(outer)).not.toContain("t3-card");
    }
  });

  it("does not treat card-looking tokens inside quoted attributes as real markup", () => {
    for (const content of [
      '<card padding={3}>\n<box label="</card>">\n' + card + "\n</box>\n</card>",
      '<box label="\n' + card + '\n">\nUnrelated text\n</box>',
      '<card padding={3}>\n<box label="<card>">\n' + card + "\n</box>\n</card>",
    ]) {
      expect(normalize(content)).not.toContain("t3-card");
    }
  });

  it("does not promote cards in lazy Markdown blockquote/list continuations", () => {
    for (const text of [
      "> A code-review quotation\n" + card,
      "- A list item\n" + card,
      "1. First numbered item\n" + card,
      "> First quoted line\nsecond lazy line\n" + card,
      "- First item\nplain lazy continuation\n" + card,
    ]) {
      expect(normalize(text)).not.toContain("t3-card");
    }
  });

  it("allows top-level cards after blank or interrupting heading boundaries", () => {
    for (const content of [
      "> Quoted paragraph\n\n" + card,
      "- List item\n\n" + card,
      "> Quoted paragraph\n# New heading\n" + card,
      "Intro paragraph\n" + card,
    ]) {
      expect(normalize(content)).toContain("t3-card");
    }
  });

  it("ignores escaped closing card delimiters when tracking parent ownership", () => {
    for (const content of [
      "<card padding={3}>\n\\</card>\n" + card + "\n</card>",
      "<card padding={3}>\n\\\\\\</card>\n" + card + "\n</card>",
    ]) {
      expect(normalize(content)).not.toContain("t3-card");
    }
  });

  it("does not treat quoted or escaped raw-block markers as real comments", () => {
    for (const content of [
      '<box label="<!--">Ignored</box>\n' + card,
      '<box label="<CodeBlock>">Ignored</box>\n' + card,
      '<box label="<WritingBlock>">Ignored</box>\n' + card,
      "\\<!-- Escaped comment\n" + card,
    ]) {
      expect(normalize(content)).toContain("t3-card");
    }
  });

  it("does not terminate raw blocks on closing tags embedded in attributes", () => {
    for (const content of [
      '<CodeBlock language="text">\n<box label="</CodeBlock>">\n' + card + "\n</box>\n</CodeBlock>",
      '<WritingBlock>\n<box label="</WritingBlock>">\n' + card + "\n</box>\n</WritingBlock>",
      "<AppBlock>\n\\</AppBlock>\n" + card + "\n</AppBlock>",
    ]) {
      expect(normalize(content)).not.toContain("t3-card");
    }
  });

  it("ends lazy list or blockquote ownership across fenced code blocks", () => {
    for (const content of [
      "- A list item\n```js\nconsole.log(1)\n```\n" + card,
      "> A quote\n~~~js\nconsole.log(1)\n~~~\n" + card,
      "1. A numbered item\n````js\nconsole.log(1)\n````\n" + card,
    ]) {
      expect(normalize(content)).toContain("t3-card");
    }
  });

  it("promotes root cards after completed quoted headings and quoted fences", () => {
    for (const content of [
      "> # Done\n" + card,
      "> ## Heading\n" + card,
      "> ```js\n> console.log(1)\n> ```\n" + card,
      "> ~~~\n> source\n> ~~~\n" + card,
    ]) {
      expect(normalize(content)).toContain("t3-card");
    }
  });

  it("keeps card markup inside unsupported HTML and DIL parents inert", () => {
    for (const content of [
      "<div>\n" + card + "\n</div>",
      "<section>\n" + card + "\n</section>",
      "<box>\n" + card + "\n</box>",
      "<row>\n" + card + "\n</row>",
      "<div>\n<article>\n" + card + "\n</article>\n</div>",
      "<div>\n" + card,
    ]) {
      expect(normalize(content)).not.toContain("t3-card");
    }
  });

  it("retains independent cards after self-closing raw components and HTML", () => {
    for (const before of [
      "<CodeBlock />",
      '<CodeBlock language="typescript" />',
      "<WritingBlock />",
      "<AppBlock />",
      '<escape char="\\\\">\u003c/escape>\u0020',
      "<escape />",
      "<div />",
      "<br>",
    ]) {
      expect(normalize(before + "\n" + card)).toContain("t3-card");
    }
  });

  it("still renders independent cards after a completed invalid card", () => {
    const output = normalize("<card padding={2}><title>Unsupported</title></card>\n" + card);
    expect(output.match(/t3-card/g)).toHaveLength(1);
    expect(output).toContain('"value":"Build status"');
  });

  it("rejects excessive static card content", () => {
    const longCard = "<card><text>" + "x".repeat(700) + "</text></card>";
    expect(normalize(longCard)).not.toContain("t3-card");
  });
});
