import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CHATGPT_AGENT_INSTANCE_ID,
  CHATGPT_AGENT_MODEL,
  normalizeChatGPTAgentModel,
  isChatGPTAgentSelection,
  isChatGPTAgentThread,
  isChatGPTAgentTurnStart,
  shouldRouteToProvider,
} from "./ChatGPTAgentRouter.ts";

describe("ChatGPTAgentRouter", () => {
  const chatgptThread = {
    modelSelection: { instanceId: CHATGPT_AGENT_INSTANCE_ID, model: "desktop" },
  };
  const providerThread = {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
  };

  it("keeps desktop threads outside every provider-only route", () => {
    expect(isChatGPTAgentSelection(chatgptThread.modelSelection)).toBe(true);
    expect(isChatGPTAgentThread(chatgptThread)).toBe(true);
    expect(shouldRouteToProvider(chatgptThread)).toBe(false);
    expect(shouldRouteToProvider(providerThread)).toBe(true);
  });

  it("routes an explicit desktop selection before a thread selection is persisted", () => {
    expect(
      isChatGPTAgentTurnStart({
        thread: providerThread,
        requestedModelSelection: chatgptThread.modelSelection,
      }),
    ).toBe(true);
  });

  it("defaults new selections to latest while accepting persisted desktop selections", () => {
    expect(CHATGPT_AGENT_MODEL).toBe("latest");
    expect(normalizeChatGPTAgentModel("desktop")).toBe("latest");
    expect(normalizeChatGPTAgentModel("5.4")).toBe("5.4");
    expect(normalizeChatGPTAgentModel("unknown")).toBe("latest");
  });
});
