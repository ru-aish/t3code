import {
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationThread,
} from "@t3tools/contracts";

/**
 * The sole routing boundary between the external ChatGPT Desktop integration
 * and provider-runtime infrastructure. Keep all provider-only code behind
 * this predicate so desktop threads never acquire provider state by accident.
 */
export const CHATGPT_AGENT_INSTANCE_ID = ProviderInstanceId.make("chatgptAgent");
/** `desktop` remains readable from persisted legacy selections. */
export const CHATGPT_AGENT_MODEL = "latest";
export const CHATGPT_AGENT_LEGACY_MODEL = "desktop";
export type ChatGPTAgentModel = "latest" | "5.5" | "5.4" | "5.3" | "o3";

export function normalizeChatGPTAgentModel(model: string | null | undefined): ChatGPTAgentModel {
  if (!model || model === CHATGPT_AGENT_LEGACY_MODEL) return CHATGPT_AGENT_MODEL;
  return ["latest", "5.5", "5.4", "5.3", "o3"].includes(model)
    ? (model as ChatGPTAgentModel)
    : CHATGPT_AGENT_MODEL;
}

export const isChatGPTAgentSelection = (
  selection: Pick<ModelSelection, "instanceId"> | undefined | null,
): boolean => selection?.instanceId === CHATGPT_AGENT_INSTANCE_ID;

export const isChatGPTAgentThread = (
  thread: Pick<OrchestrationThread, "modelSelection"> | undefined | null,
): boolean => isChatGPTAgentSelection(thread?.modelSelection);

export const isChatGPTAgentTurnStart = ({
  thread,
  requestedModelSelection,
}: {
  readonly thread: Pick<OrchestrationThread, "modelSelection"> | undefined | null;
  readonly requestedModelSelection?: Pick<ModelSelection, "instanceId"> | undefined;
}): boolean => isChatGPTAgentSelection(requestedModelSelection) || isChatGPTAgentThread(thread);

export const shouldRouteToProvider = (
  thread: Pick<OrchestrationThread, "modelSelection"> | undefined | null,
): boolean => !isChatGPTAgentThread(thread);
