import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  CHATGPT_AGENT_INSTANCE_ID,
  CHATGPT_AGENT_MODEL,
  resolveChatGPTAgentModelSelection,
} from "./chatgptAgent";

describe("ChatGPT Agent turn dispatch", () => {
  it("keeps the desktop target's instance id on the turn selection", () => {
    expect(resolveChatGPTAgentModelSelection(CHATGPT_AGENT_INSTANCE_ID)).toEqual({
      instanceId: CHATGPT_AGENT_INSTANCE_ID,
      model: CHATGPT_AGENT_MODEL,
    });
  });

  it("does not redirect normal provider selections to ChatGPT Agent", () => {
    expect(resolveChatGPTAgentModelSelection(ProviderInstanceId.make("codex"))).toBeNull();
  });
});
