// @vitest-environment jsdom
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeAgentChart } from "./SafeAgentChart";

describe("safe ChatGPT chart previews", () => {
  const chart = (type: string) =>
    JSON.stringify({
      chartType: type,
      xKey: "name",
      nameKey: "name",
      valueKey: "value",
      series: [{ dataKey: "value", label: "Value", valueSuffix: "%" }],
      data: [
        { name: "Jan", value: 10 },
        { name: "Feb", value: 20 },
      ],
    });

  it.each(["bar", "line", "scatter", "pie"])("renders an accessible %s chart", (kind) => {
    const html = renderToStaticMarkup(<SafeAgentChart source={chart(kind)} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector(`svg[role="img"][aria-label="${kind} chart"]`)).not.toBeNull();
    expect(doc.querySelector("figure")).not.toBeNull();
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.body.textContent).toContain("Value");
  });

  it("shows an inert fallback for arbitrary expressions or malformed data", () => {
    for (const source of [
      "(()=>alert(1))()",
      '{"chartType":"line","series":[],"data":[]}',
      "x".repeat(30_001),
    ]) {
      const html = renderToStaticMarkup(<SafeAgentChart source={source} />);
      expect(html).toContain("Chart preview unavailable");
      expect(html).not.toContain("<svg");
    }
  });

  it("escapes hostile labels and never interprets HTML as markup", () => {
    const value = JSON.stringify({
      chartType: "bar",
      xKey: "name",
      series: [{ dataKey: "value", label: "<script>alert(1)</script>" }],
      data: [{ name: "<img src=x onerror=alert(1)>", value: 4 }],
    });
    const html = renderToStaticMarkup(<SafeAgentChart source={value} />);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });
});
