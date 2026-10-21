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
