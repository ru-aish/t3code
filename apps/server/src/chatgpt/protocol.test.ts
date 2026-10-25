import { describe, expect, it } from "@effect/vitest";
import {
  imageUploadDestination,
  isTerminalToolCall,
  mergeFinalAnswer,
  normalizeProjects,
  normalizeStreamMessage,
} from "./protocol.ts";

describe("ChatGPT protocol", () => {
  it("recognizes scoped opaque connector aliases in live and serialized history parsing", () => {
    const serialized = new Function(
      `return (${isTerminalToolCall.toString()})`,
    )() as typeof isTerminalToolCall;
    for (const recognize of [isTerminalToolCall, serialized]) {
      const message = {
        role: "assistant",
        recipient: "api_tool.call_tool",
        text: JSON.stringify({
          path: "/asdk_app_opaque/link_opaque/bootstrap_thread",
          args: { thread_id: "thread-one" },
        }),
      };
      expect(recognize(message, "thread-one")).toBe(true);
      expect(recognize(message, "other-thread")).toBe(false);
      expect(recognize({ ...message, role: "tool" }, "thread-one")).toBe(false);
      expect(recognize({ ...message, text: "invalid JSON" }, "thread-one")).toBe(false);
      expect(
        recognize(
          {
            ...message,
            text: JSON.stringify({ path: "/other_app/search", args: { thread_id: "thread-one" } }),
          },
          "thread-one",
        ),
      ).toBe(false);
      expect(recognize({ ...message, text: "fedora_t3code.thread_task" }, "thread-one")).toBe(true);
    }
  });

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
  it("recognizes Terminal approvals by canonical invocation and exact thread scope", () => {
    const approval = (connectorId: string, threadId = "thread", pathConnector = connectorId) => ({
      message: {
        id: "approval-message",
        author: { role: "tool" },
        content: { parts: [""] },
        metadata: {
          jit_plugin_data: {
            from_server: {
              type: "confirm_action",
              body: {
                codex_mcp_elicitation: { kind: "mcpToolCall", status: "pending" },
                connector_id: connectorId,
                connector_name: "fedora_t3code",
                link_id: "link_current",
                params: {
                  path: `/${pathConnector}/link_current/bootstrap_thread`,
                  args: { thread_id: threadId },
                },
                actions: [{ always_allow: { target_message_id: "approval-message" } }],
              },
            },
          },
        },
      },
    });
    for (const connectorId of [
      "asdk_app_6ad23e985b608191984705f0c25f1ba3",
      "asdk_app_6a9b31f86efc81918287f37a02413746",
      "asdk_app_recreated_connection",
    ]) {
      const raw = approval(connectorId);
      expect(normalizeStreamMessage(raw, "thread").fedoraApproval).toEqual({
        messageId: "approval-message",
        connectorId,
        linkId: "link_current",
      });
      raw.message.metadata.jit_plugin_data.from_server.body.connector_name = "fedora";
      expect(normalizeStreamMessage(raw, "thread").fedoraApproval).toBeDefined();
      raw.message.metadata.jit_plugin_data.from_server.body.connector_name = "unrelated-app";
      expect(normalizeStreamMessage(raw, "thread").fedoraApproval).toBeUndefined();
      raw.message.metadata.jit_plugin_data.from_server.body.connector_name = "fedora_t3code";
      expect(normalizeStreamMessage(raw).fedoraApproval).toBeUndefined();
      expect(
        normalizeStreamMessage(approval(connectorId, "other-thread"), "thread").fedoraApproval,
      ).toBeUndefined();
      expect(
        normalizeStreamMessage(approval(connectorId, "thread", "asdk_app_other"), "thread")
          .fedoraApproval,
      ).toBeUndefined();
      const body = raw.message.metadata.jit_plugin_data.from_server.body;
      Object.assign(body.params.args, { session_id: "another-thread" });
      expect(normalizeStreamMessage(raw, "thread").fedoraApproval).toBeUndefined();
      Object.assign(body.params.args, { session_id: "thread" });
      Reflect.deleteProperty(body.params.args, "thread_id");
      expect(normalizeStreamMessage(raw, "thread").fedoraApproval).toBeDefined();
      body.params.path = `/${connectorId}/link_other/bootstrap_thread`;
      expect(normalizeStreamMessage(raw, "thread").fedoraApproval).toBeUndefined();
      body.params.path = `/${connectorId}/link_current/bootstrap_thread`;
      body.actions[0]!.always_allow.target_message_id = "another-message";
      expect(normalizeStreamMessage(raw, "thread").fedoraApproval).toBeUndefined();
      body.actions[0]!.always_allow.target_message_id = "approval-message";
      body.codex_mcp_elicitation.status = "accepted";
      expect(normalizeStreamMessage(raw, "thread").fedoraApproval).toBeUndefined();
    }
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
