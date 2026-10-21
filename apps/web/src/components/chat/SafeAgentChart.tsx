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
    const valueKeys =
      chartType === "pie" ? [spec.valueKey || series[0]!.dataKey] : series.map((s) => s.dataKey);
    if (!data.some((row) => valueKeys.some((key) => typeof row[key] === "number"))) return null;
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
  const entries = spec.data
    .map((row) => ({ name: String(row[nameKey] ?? ""), value: numeric(row[key]) ?? 0 }))
    .filter((entry) => entry.value > 0)
    .slice(0, 20);
  const sum = entries.reduce((total, entry) => total + entry.value, 0);
  if (!sum) return <p className="text-xs text-muted-foreground">No positive chart values.</p>;
  const slices = entries.map((entry, i) => ({
    ...entry,
    startAngle:
      -Math.PI / 2 +
      (entries.slice(0, i).reduce((total, previous) => total + previous.value, 0) / sum) *
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
        const sweep = (entry.value / sum) * Math.PI * 2;
        const startX = cx + radius * Math.cos(angle);
        const startY = cy + radius * Math.sin(angle);
        const endX = cx + radius * Math.cos(angle + sweep);
        const endY = cy + radius * Math.sin(angle + sweep);
        const path =
          entries.length === 1
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
            <title>{`${entry.name}: ${format(entry.value, spec.series[0])} (${NUMBER.format((entry.value / sum) * 100)}%)`}</title>
          </path>
        );
      })}
      {slices.slice(0, 10).map((entry, i) => (
        <g key={entry.startAngle} transform={`translate(368 ${36 + i * 26})`}>
          <rect width="12" height="12" rx="2" fill={COLORS[i % COLORS.length]} />
          <text x="21" y="11" fill="currentColor" fontSize="13">
            {entry.name.slice(0, 26)}
          </text>
        </g>
      ))}
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
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const range = high === low ? 1 : high - low;
  const y = (value: number) => TOP + PLOT_HEIGHT - ((value - low) / range) * PLOT_HEIGHT;
  const x = (index: number) =>
    LEFT +
    ((index + (spec.chartType === "bar" ? 0.5 : 0)) /
      Math.max(1, rows.length - (spec.chartType === "bar" ? 0 : 1))) *
      PLOT_WIDTH;
  const xKey = spec.xKey || "x";
  const zero = y(0);
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
        const value = low + (range * i) / 4;
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
      {spec.chartType === "pie" ? <PieChart spec={spec} /> : <CartesianChart spec={spec} />}
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
