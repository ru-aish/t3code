import { useMemo } from "react";

type Item = { kind: "title" | "text" | "caption" | "badge"; value: string; key: string };

function parseCard(source: string): Item[] | null {
  if (source.length > 4_000) return null;
  try {
    const raw: unknown = JSON.parse(source);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const items = (raw as Record<string, unknown>).items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 12) return null;
    const parsed: Item[] = [];
    const occurrences = new Map<string, number>();
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      if (
        !["title", "text", "caption", "badge"].includes(String(record.kind)) ||
        typeof record.value !== "string" ||
        !record.value.trim() ||
        record.value.length > 600
      )
        return null;
      const identity = `${record.kind}:${record.value}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      parsed.push({
        kind: record.kind as Item["kind"],
        value: record.value,
        key: `${identity}:${occurrence}`,
      });
    }
    return parsed;
  } catch {
    return null;
  }
}

/** An inert preview: model-supplied card text never becomes JSX, HTML or code. */
export function SafeAgentCard({ source }: { source: string }) {
  const items = useMemo(() => parseCard(source), [source]);
  if (!items) {
    return (
      <p className="text-xs text-muted-foreground">
        Card preview unavailable. View the source instead.
      </p>
    );
  }
  return (
    <section
      aria-label={items.find((item) => item.kind === "title")?.value ?? "ChatGPT card"}
      className="my-2 w-full min-w-0 space-y-2 rounded-xl border border-border/60 bg-card p-4 text-card-foreground shadow-sm"
    >
      {items.map((item) => {
        switch (item.kind) {
          case "title":
            return (
              <h3 key={item.key} className="text-base font-semibold leading-snug">
                {item.value}
              </h3>
            );
          case "caption":
            return (
              <p key={item.key} className="text-xs text-muted-foreground">
                {item.value}
              </p>
            );
          case "badge":
            return (
              <span
                key={item.key}
                className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
              >
                {item.value}
              </span>
            );
          default:
            return (
              <p key={item.key} className="text-sm leading-relaxed whitespace-pre-wrap">
                {item.value}
              </p>
            );
        }
      })}
    </section>
  );
}
