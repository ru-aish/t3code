import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider } from "@t3tools/contracts";
import { chatGPTConnectionMessage, shouldShowProviderAccount } from "./providerAccounts";

const provider = (overrides: Record<string, unknown> = {}) =>
  ({
    driver: "chatgpt",
    enabled: true,
    installed: false,
    auth: { status: "unknown" },
    models: [],
    ...overrides,
  }) as unknown as ServerProvider;

describe("mobile provider account visibility", () => {
  it("shows desktop-backed ChatGPT even without a mobile OAuth flow", () => {
    expect(shouldShowProviderAccount(provider())).toBe(true);
    expect(shouldShowProviderAccount(provider({ driver: "codex" }))).toBe(false);
    expect(
      shouldShowProviderAccount(provider({ driver: "codex", setup: { canAuthenticate: true } })),
    ).toBe(true);
  });

  it("distinguishes disabled, disconnected, and ready ChatGPT", () => {
    expect(chatGPTConnectionMessage(provider({ enabled: false }))).toContain("Disabled");
    expect(chatGPTConnectionMessage(provider())).toContain("Not ready");
    expect(
      chatGPTConnectionMessage(
        provider({ installed: true, auth: { status: "authenticated" }, models: [{ slug: "gpt" }] }),
      ),
    ).toContain("1 model available");
  });
});
