import type {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";

type ProjectOption = NonNullable<ModelSelection["options"]>[number];

/** Existing conversations must never silently move when a T3 project's link changes. */
export function resolveChatGPTProjectOption(input: {
  readonly explicit: ProjectOption | undefined;
  readonly projectId: ProjectId | null;
  readonly instanceId: ProviderInstanceId;
  readonly hasStarted: boolean;
  readonly settings: Pick<ServerSettings, "projectSettingsOverrides">;
}): ProjectOption | undefined {
  if (input.explicit) return input.explicit;
  if (input.hasStarted || input.projectId === null) return undefined;
  const linked =
    input.settings.projectSettingsOverrides[input.projectId]?.chatgptProjects?.[input.instanceId];
  return linked ? { id: "chatgptProjectId", value: linked } : undefined;
}
