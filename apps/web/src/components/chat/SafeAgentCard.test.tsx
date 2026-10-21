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
    expect(doc.querySelector('section[aria-label="Build status"]')).not.toBeNull();
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
