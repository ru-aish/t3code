import { assert, it } from "@effect/vitest";

import { mapCodexModelCapabilities, normalizeCodexAccountUsage } from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("normalizes Codex account limits and token usage from the authenticated app-server", () => {
  const usage = normalizeCodexAccountUsage({
    rateLimits: {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 10, resetsAt: 1_783_769_853, windowDurationMins: 300 },
        secondary: { usedPercent: 1, resetsAt: 1_784_356_653, windowDurationMins: 10_080 },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 10, resetsAt: 1_783_769_853, windowDurationMins: 300 },
          secondary: { usedPercent: 1, resetsAt: 1_784_356_653, windowDurationMins: 10_080 },
        },
      },
    },
    tokenUsage: {
      dailyUsageBuckets: [{ startDate: "2026-07-11", tokens: 8_761_134 }],
      summary: {
        currentStreakDays: 4,
        lifetimeTokens: 333_869_937,
        longestRunningTurnSec: 4_176,
        longestStreakDays: 9,
        peakDailyTokens: 65_722_326,
      },
    },
  });

  assert.deepStrictEqual(usage, {
    limits: [
      {
        id: "codex",
        primary: { usedPercent: 10, resetsAt: 1_783_769_853, windowDurationMins: 300 },
        secondary: { usedPercent: 1, resetsAt: 1_784_356_653, windowDurationMins: 10_080 },
      },
    ],
    dailyUsageBuckets: [{ startDate: "2026-07-11", tokens: 8_761_134 }],
    lifetimeTokens: 333_869_937,
    currentStreakDays: 4,
    longestStreakDays: 9,
    longestRunningTurnSec: 4_176,
    peakDailyTokens: 65_722_326,
  });
});
