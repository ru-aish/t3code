import { useMemo } from "react";

type ChartType = "bar" | "line" | "scatter" | "pie";
type Series = {
  dataKey: string;
  label?: string;
  valuePrefix?: string;
  valueSuffix?: string;
  valueFormat?: string;
};
type Spec = {
  chartType: ChartType;
  xKey?: string;
  nameKey?: string;
  valueKey?: string;
  xAxisLabel?: string;
  axisLabel?: string;
  yAxisMin?: number;
  yAxisMax?: number;
  xAxisScale?: "linear";
  layout?: "vertical";
  series: Series[];
  data: Record<string, string | number>[];
};
const WIDTH = 640;
const HEIGHT = 306;
const LEFT = 58;
const TOP = 22;
const PLOT_WIDTH = 548;
const PLOT_HEIGHT = 230;
const COLORS = ["#0284c7", "#9333ea", "#059669", "#ea580c", "#db2777", "#64748b"];
const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function parseChart(source: string): Spec | null {
  if (source.length > 30_000) return null;
  try {
    const chart: unknown = JSON.parse(source);
    if (!chart || typeof chart !== "object" || Array.isArray(chart)) return null;
    const value = chart as Record<string, unknown>;
    if (!["bar", "line", "scatter", "pie"].includes(String(value.chartType))) return null;
    if (!Array.isArray(value.data) || value.data.length > 200 || value.data.length === 0)
      return null;
    if (!Array.isArray(value.series) || value.series.length === 0 || value.series.length > 6)
      return null;
    const series: Series[] = [];
    for (const raw of value.series) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.dataKey !== "string" || !entry.dataKey || entry.dataKey.length > 100)
        return null;
      const item: Series = { dataKey: entry.dataKey };
      for (const prop of ["label", "valuePrefix", "valueSuffix", "valueFormat"] as const) {
        if (typeof entry[prop] === "string") item[prop] = entry[prop].slice(0, 80);
      }
      series.push(item);
    }
    const data: Spec["data"] = [];
    for (const row of value.data) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const object = row as Record<string, unknown>;
      if (Object.keys(object).length > 40) return null;
      const item: Record<string, string | number> = {};
      for (const [key, field] of Object.entries(object)) {
        if (typeof field === "string") item[key] = field.slice(0, 120);
        else if (typeof field === "number" && Number.isFinite(field)) item[key] = field;
      }
      data.push(item);
    }
    const chartType = value.chartType as ChartType;
    const spec: Spec = { chartType, series, data };
    for (const prop of ["xKey", "nameKey", "valueKey", "xAxisLabel", "axisLabel"] as const) {
      if (typeof value[prop] === "string") spec[prop] = value[prop].slice(0, 100);
    }
    if (value.xAxisScale !== undefined) {
      if (chartType !== "line" || value.xAxisScale !== "linear") return null;
      spec.xAxisScale = "linear";
      if (!data.every((row) => typeof row[spec.xKey || "x"] === "number")) return null;
    }
    if (value.layout !== undefined) {
      if (chartType !== "bar" || value.layout !== "vertical") return null;
      spec.layout = "vertical";
    }
    for (const prop of ["yAxisMin", "yAxisMax"] as const) {
      if (value[prop] !== undefined) {
        if (typeof value[prop] !== "number" || !Number.isFinite(value[prop])) return null;
        spec[prop] = value[prop];
      }
    }
    if (
      spec.yAxisMin !== undefined &&
      spec.yAxisMax !== undefined &&
      spec.yAxisMax <= spec.yAxisMin
    )
      return null;
    const valueKeys =
      chartType === "pie" ? [spec.valueKey || series[0]!.dataKey] : series.map((s) => s.dataKey);
    const numericValues = data.flatMap((row) =>
      valueKeys.map((key) => numeric(row[key])).filter((field): field is number => field !== null),
    );
    if (numericValues.length === 0) return null;
    if (
      spec.yAxisMin !== undefined &&
      spec.yAxisMax === undefined &&
      spec.yAxisMin >= Math.max(0, ...numericValues)
    )
      return null;
    if (
      spec.yAxisMax !== undefined &&
      spec.yAxisMin === undefined &&
      spec.yAxisMax <= Math.min(0, ...numericValues)
    )
      return null;
    return spec;
  } catch {
    return null;
  }
}

function numeric(value: string | number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function format(value: number, series?: Series): string {
  const number = series?.valueFormat === "compact" ? COMPACT.format(value) : NUMBER.format(value);
  return (series?.valuePrefix || "") + number + (series?.valueSuffix || "");
}

function PieChart({ spec }: { spec: Spec }) {
  const key = spec.valueKey || spec.series[0]!.dataKey;
  const nameKey = spec.nameKey || spec.xKey || "name";
  const positive = spec.data
    .map((row) => ({ name: String(row[nameKey] ?? ""), value: numeric(row[key]) ?? 0 }))
    .filter((entry) => entry.value > 0);
  if (positive.length === 0)
    return <p className="text-xs text-muted-foreground">No positive chart values.</p>;
  // Normalize before summing so a chart of large finite values cannot overflow.
  const scale = Math.max(...positive.map((entry) => entry.value));
  const all = positive.map((entry) => ({ ...entry, weight: entry.value / scale }));
  const totalWeight = all.reduce((sum, entry) => sum + entry.weight, 0);
  // Include every data row in the pie total, even when only 20 slices fit.
  const grouped = all.length > 20;
  const otherValues = all.slice(19);
  const otherTotal = otherValues.reduce((sum, entry) => sum + entry.value, 0);
  const entries: Array<{ name: string; value: number | null; weight: number }> = grouped
    ? [
        ...all.slice(0, 19),
        {
          name: `Other (${all.length - 19})`,
          value: Number.isFinite(otherTotal) ? otherTotal : null,
          weight: otherValues.reduce((sum, entry) => sum + entry.weight, 0),
        },
      ]
    : all;
  const slices = entries.map((entry, i) => ({
    ...entry,
    startAngle:
      -Math.PI / 2 +
      (entries.slice(0, i).reduce((sum, previous) => sum + previous.weight, 0) / totalWeight) *
        Math.PI *
        2,
  }));
  const cx = 222;
  const cy = 150;
  const radius = 112;
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label="pie chart"
      className="w-full max-h-80"
    >
      {slices.map((entry, i) => {
        const angle = entry.startAngle;
        const sweep = (entry.weight / totalWeight) * Math.PI * 2;
        const startX = cx + radius * Math.cos(angle);
        const startY = cy + radius * Math.sin(angle);
        const endX = cx + radius * Math.cos(angle + sweep);
        const endY = cy + radius * Math.sin(angle + sweep);
        const path =
          slices.length === 1
            ? `M ${cx - radius} ${cy} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 -${radius * 2} 0`
            : `M ${cx} ${cy} L ${startX} ${startY} A ${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${endX} ${endY} Z`;
        return (
          <path
            key={entry.startAngle}
            d={path}
            fill={COLORS[i % COLORS.length]}
            stroke="var(--background)"
            strokeWidth="2"
          >
            <title>{`${entry.name}: ${entry.value === null ? "Total exceeds numeric range " : `${format(entry.value, spec.series[0])} `}(${NUMBER.format((entry.weight / totalWeight) * 100)}%)`}</title>
          </path>
        );
      })}
      {(grouped ? [...slices.slice(0, 9), slices[slices.length - 1]!] : slices.slice(0, 10)).map(
        (entry, i) => (
          <g key={entry.startAngle} transform={`translate(368 ${36 + i * 26})`}>
            <rect
              width="12"
              height="12"
              rx="2"
              fill={COLORS[(grouped && i === 9 ? slices.length - 1 : i) % COLORS.length]}
            />
            <text x="21" y="11" fill="currentColor" fontSize="13">
              {entry.name.slice(0, 26)}
            </text>
          </g>
        ),
      )}
    </svg>
  );
}

function CartesianChart({ spec }: { spec: Spec }) {
  const rows = spec.data.slice(0, 100);
  const values = rows.flatMap((row) =>
    spec.series
      .map((series) => numeric(row[series.dataKey]))
      .filter((value): value is number => value !== null),
  );
  const low = spec.yAxisMin ?? Math.min(0, ...values);
  const high = spec.yAxisMax ?? Math.max(0, ...values);
  const scale = Math.max(1, Math.abs(low), Math.abs(high));
  const range = high / scale - low / scale || 1;
  const y = (value: number) => {
    const clipped = Math.max(low, Math.min(high, value));
    return TOP + PLOT_HEIGHT - ((clipped / scale - low / scale) / range) * PLOT_HEIGHT;
  };
  const xKey = spec.xKey || "x";
  const xValues = rows.map((row) => numeric(row[xKey]) ?? 0);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const xScale = Math.max(1, Math.abs(xMin), Math.abs(xMax));
  const xRange = xMax / xScale - xMin / xScale || 1;
  const x = (index: number) =>
    LEFT +
    (spec.xAxisScale === "linear"
      ? xMax === xMin
        ? PLOT_WIDTH / 2
        : ((xValues[index]! / xScale - xMin / xScale) / xRange) * PLOT_WIDTH
      : ((index + (spec.chartType === "bar" ? 0.5 : 0)) /
          Math.max(1, rows.length - (spec.chartType === "bar" ? 0 : 1))) *
        PLOT_WIDTH);
  const zero = y(Math.min(high, Math.max(low, 0)));
  const gap = PLOT_WIDTH / rows.length;
  const barWidth = Math.min(34, (gap * 0.76) / spec.series.length);
  const visibleTicks = new Set([0, rows.length - 1]);
  for (let i = 1; i < 6; i++) visibleTicks.add(Math.round((i * (rows.length - 1)) / 6));
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${spec.chartType} chart`}
      className="w-full max-h-80"
    >
      {Array.from({ length: 5 }, (_, i) => {
        const value = (low / scale + (range * i) / 4) * scale;
        return (
          <g key={i}>
            <line
              x1={LEFT}
              y1={y(value)}
              x2={LEFT + PLOT_WIDTH}
              y2={y(value)}
              stroke="currentColor"
              strokeOpacity=".13"
            />
            <text
              x={LEFT - 8}
              y={y(value) + 4}
              textAnchor="end"
              fill="currentColor"
              opacity=".7"
              fontSize="11"
            >
              {COMPACT.format(value)}
            </text>
          </g>
        );
      })}
      <line
        x1={LEFT}
        y1={zero}
        x2={LEFT + PLOT_WIDTH}
        y2={zero}
        stroke="currentColor"
        strokeOpacity=".35"
      />
      {rows.map((row, i) =>
        visibleTicks.has(i) ? (
          <text
            key={x(i)}
            x={x(i)}
            y={TOP + PLOT_HEIGHT + 20}
            textAnchor="middle"
            fill="currentColor"
            opacity=".75"
            fontSize="11"
          >
            {String(row[xKey] ?? i + 1).slice(0, 14)}
          </text>
        ) : null,
      )}
      {spec.series.map((series, seriesIndex) => {
        const color = COLORS[seriesIndex]!;
        const points = rows.map((row, i) => ({
          x: x(i),
          value: numeric(row[series.dataKey]),
          label: String(row[xKey] ?? i + 1),
        }));
        if (spec.chartType === "bar") {
          return points.map((point) =>
            point.value === null ? null : (
              <rect
                key={`${series.dataKey}-${point.x}`}
                x={point.x - (spec.series.length * barWidth) / 2 + seriesIndex * barWidth}
                y={Math.min(zero, y(point.value))}
                width={Math.max(1, barWidth - 1)}
                height={Math.max(0.5, Math.abs(y(point.value) - zero))}
                fill={color}
                rx="1"
              >
                <title>{`${point.label} · ${series.label || series.dataKey}: ${format(point.value, series)}`}</title>
              </rect>
            ),
          );
        }
        const segments: Array<Array<{ x: number; value: number; label: string }>> = [];
        let current: Array<{ x: number; value: number; label: string }> = [];
        for (const point of points) {
          if (point.value === null) {
            if (current.length) segments.push(current);
            current = [];
          } else current.push({ ...point, value: point.value });
        }
        if (current.length) segments.push(current);
        return (
          <g key={series.dataKey}>
            {spec.chartType === "line"
              ? segments.map((segment) => (
                  <polyline
                    key={segment[0]?.x}
                    points={segment.map((point) => `${point.x},${y(point.value)}`).join(" ")}
                    fill="none"
                    stroke={color}
                    strokeWidth="2.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))
              : null}
            {points.map((point) =>
              point.value === null ? null : (
                <circle
                  key={point.x}
                  cx={point.x}
                  cy={y(point.value)}
                  r={spec.chartType === "scatter" ? 4.5 : 3}
                  fill={color}
                >
                  <title>{`${point.label} · ${series.label || series.dataKey}: ${format(point.value, series)}`}</title>
                </circle>
              ),
            )}
          </g>
        );
      })}
      {spec.xAxisLabel ? (
        <text
          x={LEFT + PLOT_WIDTH / 2}
          y={HEIGHT - 7}
          textAnchor="middle"
          fill="currentColor"
          opacity=".8"
          fontSize="12"
        >
          {spec.xAxisLabel}
        </text>
      ) : null}
      {spec.axisLabel ? (
        <text
          x="14"
          y={TOP + PLOT_HEIGHT / 2}
          transform={`rotate(-90 14 ${TOP + PLOT_HEIGHT / 2})`}
          textAnchor="middle"
          fill="currentColor"
          opacity=".8"
          fontSize="12"
        >
          {spec.axisLabel}
        </text>
      ) : null}
    </svg>
  );
}

function VerticalBarChart({ spec }: { spec: Spec }) {
  const rows = spec.data.slice(0, 100);
  const values = rows.flatMap((row) =>
    spec.series
      .map((series) => numeric(row[series.dataKey]))
      .filter((value): value is number => value !== null),
  );
  const low = spec.yAxisMin ?? Math.min(0, ...values);
  const high = spec.yAxisMax ?? Math.max(0, ...values);
  const scale = Math.max(1, Math.abs(low), Math.abs(high));
  const range = high / scale - low / scale || 1;
  const x = (value: number) => {
    const clipped = Math.max(low, Math.min(high, value));
    return LEFT + ((clipped / scale - low / scale) / range) * PLOT_WIDTH;
  };
  const baseline = x(Math.min(high, Math.max(low, 0)));
  const groupHeight = PLOT_HEIGHT / rows.length;
  const barHeight = Math.min(24, (groupHeight * 0.75) / spec.series.length);
  const nameKey = spec.xKey || "x";
  const visibleTicks = new Set([0, rows.length - 1]);
  for (let i = 1; i < 6; i++) visibleTicks.add(Math.round((i * (rows.length - 1)) / 6));
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label="vertical bar chart"
      className="w-full max-h-80"
    >
      {Array.from({ length: 5 }, (_, i) => {
        const value = low / scale + ((high / scale - low / scale) * i) / 4;
        const tickX = LEFT + (i / 4) * PLOT_WIDTH;
        return (
          <g key={i}>
            <line
              x1={tickX}
              y1={TOP}
              x2={tickX}
              y2={TOP + PLOT_HEIGHT}
              stroke="currentColor"
              strokeOpacity=".13"
            />
            <text
              x={tickX}
              y={TOP + PLOT_HEIGHT + 20}
              textAnchor="middle"
              fill="currentColor"
              opacity=".7"
              fontSize="11"
            >
              {COMPACT.format(value * scale)}
            </text>
          </g>
        );
      })}
      <line
        x1={baseline}
        y1={TOP}
        x2={baseline}
        y2={TOP + PLOT_HEIGHT}
        stroke="currentColor"
        strokeOpacity=".35"
      />
      {rows.map((row, index) =>
        visibleTicks.has(index) ? (
          <text
            key={TOP + groupHeight * (index + 0.5)}
            x={LEFT - 7}
            y={TOP + groupHeight * (index + 0.5) + 4}
            textAnchor="end"
            fill="currentColor"
            opacity=".75"
            fontSize="11"
          >
            {String(row[nameKey] ?? index + 1).slice(0, 9)}
          </text>
        ) : null,
      )}
      {spec.series.flatMap((series, seriesIndex) =>
        rows.map((row, index) => {
          const value = numeric(row[series.dataKey]);
          if (value === null) return null;
          const destination = x(value);
          const label = String(row[nameKey] ?? index + 1);
          return (
            <rect
              key={`${series.dataKey}-${TOP + groupHeight * (index + 0.5)}`}
              x={Math.min(baseline, destination)}
              y={
                TOP +
                groupHeight * (index + 0.5) -
                (spec.series.length * barHeight) / 2 +
                seriesIndex * barHeight
              }
              width={Math.max(0.5, Math.abs(destination - baseline))}
              height={Math.max(0.5, barHeight - 1)}
              fill={COLORS[seriesIndex]}
              rx="1"
            >
              <title>{`${label} · ${series.label || series.dataKey}: ${format(value, series)}`}</title>
            </rect>
          );
        }),
      )}
      {spec.xAxisLabel ? (
        <text
          x={LEFT + PLOT_WIDTH / 2}
          y={HEIGHT - 7}
          textAnchor="middle"
          fill="currentColor"
          opacity=".8"
          fontSize="12"
        >
          {spec.xAxisLabel}
        </text>
      ) : null}
      {spec.axisLabel ? (
        <text
          x="14"
          y={TOP + PLOT_HEIGHT / 2}
          transform={`rotate(-90 14 ${TOP + PLOT_HEIGHT / 2})`}
          textAnchor="middle"
          fill="currentColor"
          opacity=".8"
          fontSize="12"
        >
          {spec.axisLabel}
        </text>
      ) : null}
    </svg>
  );
}

/** Visualize only the bounded, declarative data subset of ChatGPT DIL Chart. */
export function SafeAgentChart({ source }: { source: string }) {
  const spec = useMemo(() => parseChart(source), [source]);
  if (!spec) {
    return (
      <p className="text-xs text-muted-foreground">
        Chart preview unavailable. View the source instead.
      </p>
    );
  }
  return (
    <figure className="my-2 w-full overflow-x-auto rounded-md border border-border/60 bg-background px-3 py-3">
      {spec.chartType === "pie" ? (
        <PieChart spec={spec} />
      ) : spec.chartType === "bar" && spec.layout === "vertical" ? (
        <VerticalBarChart spec={spec} />
      ) : (
        <CartesianChart spec={spec} />
      )}
      {spec.chartType !== "pie" && spec.data.length > 100 ? (
        <p className="text-center text-xs text-muted-foreground">
          Showing first 100 of {spec.data.length} data points.
        </p>
      ) : null}
      <figcaption className="mt-1 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {spec.series.map((series, i) => (
          <span key={series.dataKey} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-sm"
              style={{ background: COLORS[i] }}
            />
            {series.label || series.dataKey}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
