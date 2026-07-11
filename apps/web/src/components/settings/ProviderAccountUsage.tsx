import type {
  ServerProviderAccountUsage,
  ServerProviderAccountUsageWindow,
} from "@t3tools/contracts";

const compactNumberFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatProviderTokenCount(tokens: number): string {
  return compactNumberFormatter.format(tokens);
}

export function formatProviderUsageWindowLabel(durationMins: number | undefined): string {
  if (durationMins === 300) return "5-hour";
  if (durationMins === 10_080) return "Weekly";
  if (durationMins === 1_440) return "Daily";
  if (durationMins === undefined) return "Usage";
  if (durationMins % 1_440 === 0) return `${durationMins / 1_440}-day`;
  if (durationMins % 60 === 0) return `${durationMins / 60}-hour`;
  return `${durationMins}-minute`;
}

function formatResetTime(resetsAt: number | undefined): string | undefined {
  if (resetsAt === undefined) return undefined;
  return new Date(resetsAt * 1_000).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function usageSummaryParts(usage: ServerProviderAccountUsage): ReadonlyArray<string> {
  const firstLimit = usage.limits[0];
  const parts: string[] = [];
  for (const window of [firstLimit?.primary, firstLimit?.secondary]) {
    if (!window) continue;
    parts.push(
      `${formatProviderUsageWindowLabel(window.windowDurationMins)} ${window.usedPercent}% used`,
    );
  }
  if (usage.lifetimeTokens !== undefined) {
    parts.push(`${formatProviderTokenCount(usage.lifetimeTokens)} lifetime tokens`);
  }
  return parts;
}

export function ProviderAccountUsageSummary(props: { readonly usage: ServerProviderAccountUsage }) {
  const parts = usageSummaryParts(props.usage);
  if (parts.length === 0) return null;

  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground/80">
      <span>Account usage</span>
      <span aria-hidden>·</span>
      <span>{parts.join(" · ")}</span>
    </p>
  );
}

function UsageWindowCard(props: {
  readonly window: ServerProviderAccountUsageWindow;
  readonly fallbackLabel: string;
}) {
  const label =
    formatProviderUsageWindowLabel(props.window.windowDurationMins) || props.fallbackLabel;
  const resetTime = formatResetTime(props.window.resetsAt);

  return (
    <div className="rounded-md border border-border/70 bg-muted/15 p-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{label} limit</span>
        <span className="tabular-nums text-muted-foreground">{props.window.usedPercent}% used</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${props.window.usedPercent}%` }}
          role="progressbar"
          aria-label={`${label} account usage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={props.window.usedPercent}
        />
      </div>
      {resetTime ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">Resets {resetTime}</p>
      ) : null}
    </div>
  );
}

export function ProviderAccountUsageSection(props: { readonly usage: ServerProviderAccountUsage }) {
  const windows = props.usage.limits.flatMap((limit, limitIndex) =>
    [
      limit.primary
        ? {
            key: `${limit.id ?? limitIndex}:primary`,
            window: limit.primary,
            fallbackLabel: "Primary",
          }
        : undefined,
      limit.secondary
        ? {
            key: `${limit.id ?? limitIndex}:secondary`,
            window: limit.secondary,
            fallbackLabel: "Secondary",
          }
        : undefined,
    ].filter(
      (
        entry,
      ): entry is {
        readonly key: string;
        readonly window: ServerProviderAccountUsageWindow;
        readonly fallbackLabel: string;
      } => entry !== undefined,
    ),
  );
  const stats = [
    props.usage.lifetimeTokens !== undefined
      ? { label: "Lifetime tokens", value: formatProviderTokenCount(props.usage.lifetimeTokens) }
      : undefined,
    props.usage.peakDailyTokens !== undefined
      ? { label: "Peak daily", value: formatProviderTokenCount(props.usage.peakDailyTokens) }
      : undefined,
    props.usage.currentStreakDays !== undefined
      ? { label: "Current streak", value: `${props.usage.currentStreakDays} days` }
      : undefined,
    props.usage.longestStreakDays !== undefined
      ? { label: "Longest streak", value: `${props.usage.longestStreakDays} days` }
      : undefined,
  ].filter(
    (entry): entry is { readonly label: string; readonly value: string } => entry !== undefined,
  );

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <div className="grid gap-3">
        <div>
          <p className="text-xs font-medium text-foreground">Account usage</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Read through the authenticated Codex session. No separate OpenAI API key is required.
          </p>
        </div>
        {windows.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {windows.map((entry) => (
              <UsageWindowCard
                key={entry.key}
                window={entry.window}
                fallbackLabel={entry.fallbackLabel}
              />
            ))}
          </div>
        ) : null}
        {stats.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stats.map((stat) => (
              <div key={stat.label} className="rounded-md border border-border/70 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">{stat.label}</p>
                <p className="mt-0.5 text-sm font-medium tabular-nums text-foreground">
                  {stat.value}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
