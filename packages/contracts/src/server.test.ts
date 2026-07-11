import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("decodes provider account usage snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      accountUsage: {
        limits: [
          {
            id: "codex",
            primary: {
              usedPercent: 10,
              resetsAt: 1_783_769_853,
              windowDurationMins: 300,
            },
            secondary: {
              usedPercent: 1,
              resetsAt: 1_784_356_653,
              windowDurationMins: 10_080,
            },
          },
        ],
        dailyUsageBuckets: [{ startDate: "2026-07-11", tokens: 8_761_134 }],
        lifetimeTokens: 333_869_937,
      },
      checkedAt: "2026-07-11T00:00:00.000Z",
      models: [],
    });

    expect(parsed.accountUsage?.limits[0]?.primary?.usedPercent).toBe(10);
    expect(parsed.accountUsage?.limits[0]?.secondary?.windowDurationMins).toBe(10_080);
    expect(parsed.accountUsage?.lifetimeTokens).toBe(333_869_937);
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });
});
