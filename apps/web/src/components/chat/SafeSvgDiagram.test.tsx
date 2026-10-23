// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { sanitizeAgentSvg } from "./SafeSvgDiagram";

describe("agent SVG previews", () => {
  it("renders harmless inline illustrations", () => {
    const result = sanitizeAgentSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg>',
    );
    expect(result).toContain("<circle");
    expect(result).toContain('viewBox="0 0 10 10"');
  });

  it("accepts SVG without an explicit namespace", () => {
    expect(sanitizeAgentSvg('<svg viewBox="0 0 10 10"><path d="M0 0 L10 10"/></svg>')).toContain(
      "<path",
    );
  });

  it("removes script, handlers, external resources, and clickable links", () => {
    const result = sanitizeAgentSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><a href="https://example.com"><rect width="8" height="8"/></a><image href="https://example.com/x.svg"/><rect fill="url(https://example.com/a)" style="color:red"/></svg>',
    );
    expect(result).not.toMatch(/<script|<a\b|<image|onload|href=|style=|url\(/i);
    expect(result).toContain("<rect");
  });

  it("does not allow SVG classes to position artwork over the application", () => {
    const result = sanitizeAgentSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" class="fixed inset-0 z-50 w-screen pointer-events-auto"><rect class="fixed top-0" width="100%" height="100%"/></svg>',
    );
    expect(result).toContain("<rect");
    expect(result).not.toMatch(/class=|fixed|z-50|pointer-events-auto/);
  });

  it("rejects malformed, non-SVG, and excessively large input", () => {
    expect(sanitizeAgentSvg("<div>Hi</div>")).toBeNull();
    expect(sanitizeAgentSvg("<svg><circle></svg>")).toBeNull();
    expect(sanitizeAgentSvg("<svg>" + " ".repeat(100_001) + "</svg>")).toBeNull();
  });
});
