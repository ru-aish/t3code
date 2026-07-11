import { describe, expect, it } from "vite-plus/test";

import { formatProviderTokenCount, formatProviderUsageWindowLabel } from "./ProviderAccountUsage";

describe("ProviderAccountUsage", () => {
  it("labels the standard Codex subscription windows", () => {
    expect(formatProviderUsageWindowLabel(300)).toBe("5-hour");
    expect(formatProviderUsageWindowLabel(10_080)).toBe("Weekly");
  });

  it("formats large token totals compactly", () => {
    expect(formatProviderTokenCount(333_869_937)).toBe("333.9M");
  });
});
