import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import {
  CHATGPT_AGENT_INSTANCE_ID,
  CHATGPT_AGENT_MODEL,
  CHATGPT_AGENT_MODELS,
  resolveChatGPTAgentModelSelection,
} from "./chatgptAgent";
import { getComposerProviderState } from "./components/chat/composerProviderState";
import { deriveEffectiveComposerModelState } from "./composerDraftStore";

describe("ChatGPT Agent turn dispatch", () => {
  it("keeps the desktop target's instance id on the turn selection", () => {
    expect(
      resolveChatGPTAgentModelSelection({
        instanceId: CHATGPT_AGENT_INSTANCE_ID,
        model: "desktop",
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    ).toEqual({
      instanceId: CHATGPT_AGENT_INSTANCE_ID,
      model: CHATGPT_AGENT_MODEL,
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("does not redirect normal provider selections to ChatGPT Agent", () => {
    expect(
      resolveChatGPTAgentModelSelection({
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5",
        options: [],
      }),
    ).toBeNull();
  });

  it("defaults new ChatGPT models to High while preserving a saved thread effort", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("chatgptAgent"),
      model: CHATGPT_AGENT_MODEL,
      models: CHATGPT_AGENT_MODELS,
      modelOptions: [{ id: "reasoningEffort", value: "medium" }],
    });
    expect(state.modelOptionsForDispatch).toEqual([{ id: "reasoningEffort", value: "medium" }]);

    const fresh = getComposerProviderState({
      provider: ProviderDriverKind.make("chatgptAgent"),
      model: "5.5",
      models: CHATGPT_AGENT_MODELS,
      modelOptions: undefined,
    });
    expect(fresh.modelOptionsForDispatch).toEqual([{ id: "reasoningEffort", value: "high" }]);
  });

  it("restores a thread's saved reasoning instead of stale draft reasoning", () => {
    const state = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: CHATGPT_AGENT_INSTANCE_ID,
        modelSelectionByProvider: {
          [CHATGPT_AGENT_INSTANCE_ID]: {
            instanceId: CHATGPT_AGENT_INSTANCE_ID,
            model: CHATGPT_AGENT_MODEL,
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        },
      },
      providers: [],
      selectedProvider: ProviderDriverKind.make("chatgptAgent"),
      selectedInstanceId: CHATGPT_AGENT_INSTANCE_ID,
      threadModelSelection: {
        instanceId: CHATGPT_AGENT_INSTANCE_ID,
        model: CHATGPT_AGENT_MODEL,
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
    expect(state.modelOptions).toEqual({
      [CHATGPT_AGENT_INSTANCE_ID]: [{ id: "reasoningEffort", value: "medium" }],
    });
  });

  it("uses each constrained model's valid reasoning default", () => {
    for (const [model, value] of [
      ["5.3", "instant"],
      ["o3", "medium"],
    ] as const) {
      const state = getComposerProviderState({
        provider: ProviderDriverKind.make("chatgptAgent"),
        model,
        models: CHATGPT_AGENT_MODELS,
        // A saved unsupported value must not be dispatched to a constrained model.
        modelOptions: [{ id: "reasoningEffort", value: "high" }],
      });
      expect(state.modelOptionsForDispatch).toEqual([{ id: "reasoningEffort", value }]);
    }
  });
});
