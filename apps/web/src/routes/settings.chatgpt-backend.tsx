import { createFileRoute } from "@tanstack/react-router";
import { ChatGPTBackendSettingsPanel } from "../components/settings/ChatGPTBackendSettings";

export const Route = createFileRoute("/settings/chatgpt-backend")({
  component: ChatGPTBackendSettingsPanel,
});
