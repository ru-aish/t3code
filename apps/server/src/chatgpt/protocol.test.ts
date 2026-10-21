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

  it("supports self-closing SVG with whitespace", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" />';
    const output = normalizeStreamMessage({
      message: { author: { role: "assistant" }, channel: "final", content: { parts: [svg] } },
    }).text;
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
});
