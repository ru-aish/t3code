import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import type { ProviderInstanceEntry } from "./providerInstances";

export const CHATGPT_AGENT_INSTANCE_ID = ProviderInstanceId.make("chatgptAgent");
export const CHATGPT_AGENT_DRIVER = ProviderDriverKind.make("chatgptAgent");
export const CHATGPT_AGENT_MODEL = "desktop";

/** Presentation-only picker entry. It never represents a provider runtime. */
export function chatgptAgentPickerEntry(settings: UnifiedSettings): ProviderInstanceEntry | null {
  if (!settings.chatgptAgent.enabled) return null;
  const snapshot: ServerProvider = {
    instanceId: CHATGPT_AGENT_INSTANCE_ID,
    driver: CHATGPT_AGENT_DRIVER,
    displayName: "ChatGPT Agent",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date(0).toISOString(),
    availability: "available",
    models: [
      {
        slug: CHATGPT_AGENT_MODEL,
        name: "ChatGPT Desktop",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
  return {
    instanceId: CHATGPT_AGENT_INSTANCE_ID,
    driverKind: CHATGPT_AGENT_DRIVER,
    displayName: "ChatGPT Agent",
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: true,
    isAvailable: true,
    snapshot,
    models: snapshot.models,
  };
}

export const isChatGPTAgentInstance = (id: ProviderInstanceId | null | undefined) =>
  id === CHATGPT_AGENT_INSTANCE_ID;

/**
 * ChatGPT Agent is a local desktop target, not a provider-runtime instance.
 * Keep its canonical selection in one place so picker state and turn dispatch
 * cannot fall back to a server-reported provider model.
 */
export function resolveChatGPTAgentModelSelection(
  instanceId: ProviderInstanceId,
): ModelSelection | null {
  return isChatGPTAgentInstance(instanceId)
    ? createModelSelection(CHATGPT_AGENT_INSTANCE_ID, CHATGPT_AGENT_MODEL)
    : null;
}
