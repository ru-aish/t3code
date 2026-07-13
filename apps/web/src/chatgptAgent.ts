import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelCapabilities,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import type { ProviderInstanceEntry } from "./providerInstances";

export const CHATGPT_AGENT_INSTANCE_ID = ProviderInstanceId.make("chatgptAgent");
export const CHATGPT_AGENT_DRIVER = ProviderDriverKind.make("chatgptAgent");
export const CHATGPT_AGENT_MODEL = "latest";
export const CHATGPT_AGENT_LEGACY_MODEL = "desktop";

export type ChatGPTAgentReasoningEffort = "instant" | "medium" | "high";

const reasoningCapabilities = (
  efforts: ReadonlyArray<ChatGPTAgentReasoningEffort>,
  preferred: ChatGPTAgentReasoningEffort,
): ModelCapabilities => ({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Intelligence",
      type: "select",
      options: efforts.map((effort) => ({
        id: effort,
        label: effort.charAt(0).toUpperCase() + effort.slice(1),
        ...(effort === preferred ? { isDefault: true } : {}),
      })),
      currentValue: preferred,
    },
  ],
});

/**
 * Consumer ChatGPT model versions currently exposed by the authenticated
 * desktop quick-chat surface. The stable version ids are persisted in T3;
 * ChatGPT Desktop resolves each version to its current concrete model slug.
 */
export const CHATGPT_AGENT_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: CHATGPT_AGENT_MODEL,
    name: "GPT-5.6 Sol",
    shortName: "GPT-5.6 Sol",
    isCustom: false,
    capabilities: reasoningCapabilities(["instant", "medium", "high"], "high"),
  },
  {
    slug: "5.5",
    name: "GPT-5.5",
    shortName: "GPT-5.5",
    isCustom: false,
    capabilities: reasoningCapabilities(["instant", "medium", "high"], "high"),
  },
  {
    slug: "5.4",
    name: "GPT-5.4",
    shortName: "GPT-5.4",
    isCustom: false,
    capabilities: reasoningCapabilities(["instant", "medium", "high"], "high"),
  },
  {
    slug: "5.3",
    name: "GPT-5.3",
    shortName: "GPT-5.3",
    isCustom: false,
    capabilities: reasoningCapabilities(["instant"], "instant"),
  },
  {
    slug: "o3",
    name: "o3",
    shortName: "o3",
    isCustom: false,
    capabilities: reasoningCapabilities(["medium"], "medium"),
  },
];

const CHATGPT_AGENT_MODEL_IDS = new Set(CHATGPT_AGENT_MODELS.map((model) => model.slug));

export function normalizeChatGPTAgentModel(model: string | null | undefined): string {
  if (!model || model === CHATGPT_AGENT_LEGACY_MODEL) return CHATGPT_AGENT_MODEL;
  return CHATGPT_AGENT_MODEL_IDS.has(model) ? model : CHATGPT_AGENT_MODEL;
}

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
    models: CHATGPT_AGENT_MODELS,
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
 * Normalize a ChatGPT Agent selection without dropping the selected version or
 * reasoning choice. Legacy `desktop` selections migrate to the latest version.
 */
export function resolveChatGPTAgentModelSelection(
  selection: Pick<ModelSelection, "instanceId" | "model" | "options">,
): ModelSelection | null {
  return isChatGPTAgentInstance(selection.instanceId)
    ? createModelSelection(
        CHATGPT_AGENT_INSTANCE_ID,
        normalizeChatGPTAgentModel(selection.model),
        selection.options,
      )
    : null;
}
