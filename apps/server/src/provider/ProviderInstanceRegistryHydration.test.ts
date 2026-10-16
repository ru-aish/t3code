import {
  DEFAULT_SERVER_SETTINGS,
  isUnconfiguredDefaultInstanceEnabled,
  resolveProviderInstanceEnabled,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const projectId = ProjectId.make("project-a");
const instanceId = ProviderInstanceId.make("codex_work");

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

describe("deriveProviderInstanceConfigMap", () => {
  it("activates the included ChatGPT provider for an existing installation without a saved entry", () => {
    const chatgptId = ProviderInstanceId.make("chatgpt");
    const merged = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [ProviderInstanceId.make("opencode")]: {
            driver: ProviderDriverKind.make("opencode"),
            enabled: true,
          },
        },
      }),
    );
    expect(merged[chatgptId]).toEqual({ driver: ProviderDriverKind.make("chatgpt") });
    expect(resolveProviderInstanceEnabled(merged[chatgptId]!)).toBe(true);
    expect(isUnconfiguredDefaultInstanceEnabled(chatgptId)).toBe(true);
  });

  it("retains all existing built-in providers and their saved enablement when adding ChatGPT", () => {
    const enabled = ["opencode", "antigravity"] as const;
    const merged = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          opencode: { driver: ProviderDriverKind.make("opencode"), enabled: true },
          antigravity: { driver: ProviderDriverKind.make("antigravity"), enabled: true },
        },
      }),
    );
    for (const driver of [
      "codex",
      "chatgpt",
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
      "antigravity",
      "pi",
      "muse",
    ]) {
      expect(merged[ProviderInstanceId.make(driver)]?.driver).toBe(ProviderDriverKind.make(driver));
    }
    // ACP Registry is an optional adapter with no automatic default instance.
    for (const driver of enabled) {
      const saved = merged[ProviderInstanceId.make(driver)]!;
      expect(saved.enabled).toBe(true);
      expect(resolveProviderInstanceEnabled(saved)).toBe(true);
    }
  });

  it("preserves an explicit ChatGPT opt-out", () => {
    const chatgptId = ProviderInstanceId.make("chatgpt");
    const merged = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [chatgptId]: { driver: ProviderDriverKind.make("chatgpt"), enabled: false },
        },
      }),
    );
    expect(resolveProviderInstanceEnabled(merged[chatgptId]!)).toBe(false);
  });

  it("turns a machine-disabled instance on when a project enables it", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({ driver: ProviderDriverKind.make("codex"), enabled: true });
  });

  it("clears a nested config.enabled:false flag when a project enables the instance", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: false },
        },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { enabled: true },
    });
  });

  it("leaves an already machine-enabled instance untouched", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBe(settings.providerInstances[instanceId]);
  });

  it("does not revive an instance a project override references but settings no longer configure", () => {
    const settings = settingsWith({
      providerInstances: {},
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBeUndefined();
  });

  it("ignores a project override that disables an instance, leaving the machine's config in charge", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBe(settings.providerInstances[instanceId]);
  });

  it("folds overrides from multiple projects", () => {
    const otherInstanceId = ProviderInstanceId.make("claudeAgent_personal");
    const otherProjectId = ProjectId.make("project-b");
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        [otherInstanceId]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
        [otherProjectId]: { providerInstances: { [otherInstanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({ driver: ProviderDriverKind.make("codex"), enabled: true });
    expect(merged[otherInstanceId]).toEqual({
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
    });
  });
});
