// @vitest-environment jsdom
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeAgentCard } from "./SafeAgentCard";

describe("safe ChatGPT card preview", () => {
  it("renders static DIL card items as readable, accessible UI", () => {
    const source = JSON.stringify({
      items: [
        { kind: "title", value: "Build status" },
        { kind: "badge", value: "Passed" },
        { kind: "text", value: "Checks passed" },
        { kind: "caption", value: "Today" },
      ],
    });
    const doc = new DOMParser().parseFromString(
      renderToStaticMarkup(<SafeAgentCard source={source} />),
      "text/html",
    );
    expect(doc.querySelector("section[aria-labelledby]")).not.toBeNull();
    expect(doc.querySelector("section")?.getAttribute("aria-labelledby")).toBe(
      doc.querySelector("h3")?.id,
    );
    expect(doc.querySelector("h3")?.textContent).toBe("Build status");
    expect(doc.body.textContent).toContain("Passed");
    expect(doc.body.textContent).toContain("Today");
  });

  it("never interprets card text as HTML or scripts", () => {
    const source = JSON.stringify({
      items: [{ kind: "text", value: "<script>alert(1)</script>" }],
    });
    const html = renderToStaticMarkup(<SafeAgentCard source={source} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("decodes character references exactly once and renders safe emphasis", () => {
    const source = JSON.stringify({
      items: [
        { kind: "title", value: "Tom &amp; Jerry" },
        { kind: "text", value: "Save **20%** with &amp;amp; or &copy;" },
        { kind: "caption", value: "Use `code` or *italics*" },
      ],
    });
    const doc = new DOMParser().parseFromString(
      renderToStaticMarkup(<SafeAgentCard source={source} />),
      "text/html",
    );
    expect(doc.querySelector("h3")?.textContent).toBe("Tom & Jerry");
    expect(doc.querySelector("p strong")?.textContent).toBe("20%");
    expect(doc.body.textContent).toContain("&amp; or ©");
    expect(doc.querySelector("em")?.textContent).toBe("italics");
    expect(doc.querySelector("code")?.textContent).toBe("code");
  });

  it("keeps links, images, and raw script strings inert", () => {
    const source = JSON.stringify({
      items: [
        {
          kind: "text",
          value:
            "[go](javascript:alert(1)) ![alt](https://x.invalid/image.png) <script>alert(2)</script>",
        },
      ],
    });
    const html = renderToStaticMarkup(<SafeAgentCard source={source} />);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img ");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });

  it("rejects malformed or out-of-bounds card specs", () => {
    for (const source of [
      "(() => 1)()",
      "{}",
      '{"items":[]}',
      '{"items":[{"kind":"button","value":"Click"}]}',
      JSON.stringify({ items: [{ kind: "text", value: "x".repeat(601) }] }),
      JSON.stringify({ items: Array.from({ length: 13 }, () => ({ kind: "text", value: "x" })) }),
    ]) {
      const html = renderToStaticMarkup(<SafeAgentCard source={source} />);
      expect(html).toContain("Card preview unavailable");
      expect(html).not.toContain("<section");
    }
  });
});
