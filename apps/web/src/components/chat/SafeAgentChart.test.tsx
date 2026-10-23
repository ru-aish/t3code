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

  it("includes hidden pie categories in the total through an Other slice", () => {
    const source = JSON.stringify({
      chartType: "pie",
      nameKey: "name",
      valueKey: "value",
      series: [{ dataKey: "value" }],
      data: Array.from({ length: 25 }, (_, i) => ({ name: `Category ${i + 1}`, value: 1 })),
    });
    const markup = renderToStaticMarkup(<SafeAgentChart source={source} />);
    expect(markup).toContain("Other (6)");
    expect(markup).toContain("24%");
    expect(markup).toContain("Category 1: 1 (4%)");
  });

  it("discloses when a cartesian chart previews only part of the data", () => {
    const source = JSON.stringify({
      chartType: "line",
      xKey: "name",
      series: [{ dataKey: "value" }],
      data: Array.from({ length: 150 }, (_, i) => ({ name: `Point ${i}`, value: i })),
    });
    const markup = renderToStaticMarkup(<SafeAgentChart source={source} />);
    expect(markup).toContain("Showing first 100 of 150 data points.");
  });

  it("keeps finite paths for pie values whose raw total would overflow", () => {
    const source = JSON.stringify({
      chartType: "pie",
      nameKey: "name",
      valueKey: "value",
      series: [{ dataKey: "value" }],
      data: [
        { name: "A", value: 1e308 },
        { name: "B", value: 1e308 },
      ],
    });
    const markup = renderToStaticMarkup(<SafeAgentChart source={source} />);
    expect(markup).toContain("50%");
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Infinity");
  });

  it("respects the numeric linear x scale instead of spacing irregular dates equally", () => {
    const source = JSON.stringify({
      chartType: "line",
      xAxisScale: "linear",
      xKey: "year",
      series: [{ dataKey: "value" }],
      data: [
        { year: 0, value: 2 },
        { year: 1, value: 4 },
        { year: 100, value: 6 },
      ],
    });
    const markup = renderToStaticMarkup(<SafeAgentChart source={source} />);
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const circles = Array.from(doc.querySelectorAll('svg[aria-label="line chart"] circle'));
    expect(circles).toHaveLength(3);
    expect(Number(circles[0]?.getAttribute("cx"))).toBeCloseTo(58);
    expect(Number(circles[1]?.getAttribute("cx"))).toBeCloseTo(63.48);
    expect(Number(circles[2]?.getAttribute("cx"))).toBeCloseTo(606);
  });

  it("renders a vertical bar layout as horizontal bars", () => {
    const source = JSON.stringify({
      chartType: "bar",
      layout: "vertical",
      xKey: "name",
      series: [{ dataKey: "value" }],
      data: [
        { name: "Alpha", value: 5 },
        { name: "Beta", value: 10 },
      ],
    });
    const markup = renderToStaticMarkup(<SafeAgentChart source={source} />);
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const bars = Array.from(doc.querySelectorAll('svg[aria-label="vertical bar chart"] rect'));
    expect(bars).toHaveLength(2);
    expect(Number(bars[0]?.getAttribute("width"))).toBeLessThan(
      Number(bars[1]?.getAttribute("width")),
    );
    expect(doc.body.textContent).toContain("Alpha");
  });

  it("applies an explicitly bounded numeric axis", () => {
    const source = JSON.stringify({
      chartType: "line",
      xKey: "name",
      yAxisMin: 0,
      yAxisMax: 20,
      series: [{ dataKey: "value" }],
      data: [
        { name: "A", value: 0 },
        { name: "B", value: 10 },
      ],
    });
    const markup = renderToStaticMarkup(<SafeAgentChart source={source} />);
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const circles = Array.from(doc.querySelectorAll('svg[aria-label="line chart"] circle'));
    expect(Number(circles[0]?.getAttribute("cy"))).toBeCloseTo(252);
    expect(Number(circles[1]?.getAttribute("cy"))).toBeCloseTo(137);
  });

  it("does not overflow geometry with widely separated extreme finite values", () => {
    const source = JSON.stringify({
      chartType: "line",
      xAxisScale: "linear",
      xKey: "x",
      series: [{ dataKey: "value" }],
      data: [
        { x: -1e308, value: -1e308 },
        { x: 1e308, value: 1e308 },
      ],
    });
    const markup = renderToStaticMarkup(<SafeAgentChart source={source} />);
    expect(markup).not.toContain('cx="NaN"');
    expect(markup).not.toContain('cy="NaN"');
    expect(markup).not.toContain('cx="Infinity"');
    expect(markup).not.toContain('cy="Infinity"');
  });

  it("clips large numeric values to narrow explicit axis bounds without invalid SVG geometry", () => {
    for (const layout of [undefined, "vertical"] as const) {
      const source = JSON.stringify({
        chartType: layout ? "bar" : "line",
        ...(layout ? { layout } : {}),
        xKey: "year",
        yAxisMin: 0,
        yAxisMax: 1e-308,
        series: [{ dataKey: "value" }],
        data: [
          { year: "A", value: 1e308 },
          { year: "B", value: 5e307 },
        ],
      });
      const markup = renderToStaticMarkup(<SafeAgentChart source={source} />);
      expect(markup).not.toContain("NaN");
      expect(markup).not.toContain('="Infinity"');
      expect(markup).not.toContain('="-Infinity"');
      expect(markup).toContain("<svg");
    }
    const bar = JSON.stringify({
      chartType: "bar",
      yAxisMin: 0,
      yAxisMax: 1e-308,
      series: [{ dataKey: "value" }],
      data: [{ x: "A", value: 1e308 }],
    });
    const markup = renderToStaticMarkup(<SafeAgentChart source={bar} />);
    expect(markup).not.toContain('height="Infinity"');
  });

  it("renders both axis labels on horizontal-bar layouts", () => {
    const source = JSON.stringify({
      chartType: "bar",
      layout: "vertical",
      xKey: "store",
      xAxisLabel: "Sales in dollars",
      axisLabel: "Store",
      series: [{ dataKey: "sales" }],
      data: [
        { store: "East", sales: 12 },
        { store: "West", sales: 7 },
      ],
    });
    const markup = renderToStaticMarkup(<SafeAgentChart source={source} />);
    expect(markup).toContain("Sales in dollars");
    expect(markup).toContain(">Store</text>");
  });

  it("reports numeric subtotals for grouped pie categories", () => {
    const source = JSON.stringify({
      chartType: "pie",
      nameKey: "name",
      valueKey: "value",
      series: [{ dataKey: "value" }],
      data: Array.from({ length: 25 }, (_, index) => ({
        name: `Category ${index + 1}`,
        value: index < 19 ? 1 : 10,
      })),
    });
    const markup = renderToStaticMarkup(<SafeAgentChart source={source} />);
    expect(markup).toContain("Other (6): 60 (75.95%)");
    const overflow = JSON.stringify({
      chartType: "pie",
      nameKey: "name",
      valueKey: "value",
      series: [{ dataKey: "value" }],
      data: Array.from({ length: 25 }, (_, index) => ({ name: `${index}`, value: 1e308 })),
    });
    expect(renderToStaticMarkup(<SafeAgentChart source={overflow} />)).toContain(
      "Other (6): Total exceeds numeric range",
    );
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
