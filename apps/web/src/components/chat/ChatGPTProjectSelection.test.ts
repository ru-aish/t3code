import { DEFAULT_SERVER_SETTINGS, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveChatGPTProjectOption } from "./ChatGPTProjectSelection";

const projectId = ProjectId.make("t3-project");
const instanceId = ProviderInstanceId.make("chatgpt");
const linked = {
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsOverrides: {
    [projectId]: { chatgptProjects: { [instanceId]: "g-p-linked-project" } },
  },
};

const resolve = (overrides: Partial<Parameters<typeof resolveChatGPTProjectOption>[0]> = {}) =>
  resolveChatGPTProjectOption({
    explicit: undefined,
    projectId,
    instanceId,
    hasStarted: false,
    settings: linked,
    ...overrides,
  });

describe("ChatGPT project linking", () => {
  it("selects the linked project for new T3 threads", () => {
    expect(resolve()).toEqual({ id: "chatgptProjectId", value: "g-p-linked-project" });
  });

  it("preserves a manual override, including General ChatGPT", () => {
    expect(resolve({ explicit: { id: "chatgptProjectId", value: "general" } })).toEqual({
      id: "chatgptProjectId",
      value: "general",
    });
    expect(resolve({ explicit: { id: "chatgptProjectId", value: "g-p-other" } })).toEqual({
      id: "chatgptProjectId",
      value: "g-p-other",
    });
  });

  it("does not retroactively link existing conversations", () => {
    expect(resolve({ hasStarted: true })).toBeUndefined();
  });

  it("keeps mappings isolated by T3 project and ChatGPT provider instance", () => {
    expect(resolve({ projectId: ProjectId.make("other") })).toBeUndefined();
    expect(resolve({ instanceId: ProviderInstanceId.make("other-chatgpt") })).toBeUndefined();
    expect(resolve({ projectId: null })).toBeUndefined();
  });
});
